"use strict";

/**
 * Vobiz × Zoho PhoneBridge backend.
 *
 * Zoho calls /zoho/phonebridge/clicktodial when a user clicks a number. The
 * number is handed to that agent's softphone (public/agent-phone.html) over a
 * server-sent-events stream; the browser places the SIP INVITE itself, and
 * /answer bridges the customer with <Dial><Number>. Call state goes back to
 * Zoho over callnotify as it happens, and the call log — duration and signed
 * recording link — lands with the final `ended`.
 *
 * Route groups and who may call them (see auth.js):
 *   public   /health, /agent-phone, /jssip.min.js, /admin/login
 *   agent    /agent/me, /call-events,            vz_agent cookie
 *            /agent/vobiz-session, /agent/sip-session,
 *            /agent/caller-id, /agent/enable-inbound,
 *            /agent/inbound-answered, /agent/call-failed
 *   admin    /zoho/phonebridge/{connect,complete,register,disconnect,status,debug},
 *            /admin/agent-links, /admin/vobiz-account,
 *            /admin/vobiz-account/disconnect     ADMIN_TOKEN
 *   Zoho     /zoho/phonebridge/clicktodial        HMAC token in the registered URI
 *            /zoho/phonebridge/callback           signed OAuth state
 *            /zoho/phonebridge/recording          HMAC-signed, expiring link
 *   Vobiz    /answer, /hangup, /inbound-answer, /dial-event, /dial-result,
 *            /recording-ready                     X-Vobiz-Signature-V3 (or V2,
 *                                                 MA-V3, MA-V2), REQUIRED by
 *                                                 default, checked with the token
 *                                                 of the account the webhook
 *                                                 belongs to
 *
 * No Vobiz account is configured in env. An admin connects each Vobiz account
 * once (/admin/vobiz-account); its Auth Token is sealed on disk and never
 * reaches an agent. Agents sign in from the softphone without it (vobiz-
 * accounts.js provisions that account's application and the agent's SIP
 * endpoint), or "SIP direct" with an existing endpoint's SIP login and a
 * caller ID. Typing the Auth Token into the softphone is refused unless
 * ALLOW_AGENT_AUTH_TOKEN=true. Webhooks are routed back to the account whose
 * token verified their signature.
 *
 * No request input can stop the process: every route runs inside an error
 * guard, and nothing that parses the request throws outside one.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {
  // No local .env — expected when deployed, where env vars are set on the host.
}

const zohoPhoneBridge = require("./zoho-phonebridge");
const { createAuth } = require("./auth");
const { parseKey } = require("./token-store");
const { getAgent, loadAgents, matchAgentsToZohoUsers, agentForZohoUser } = require("./agents");
const vobizAccounts = require("./vobiz-accounts");

const {
  PORT,
  ZOHO_PB_CLIENT_ID,
  ZOHO_PB_CLIENT_SECRET,
  ZOHO_PB_REDIRECT_URI,
} = process.env;

const auth = createAuth();
const pbCredentials = () => ({ clientId: ZOHO_PB_CLIENT_ID, clientSecret: ZOHO_PB_CLIENT_SECRET });

function getPublicBaseUrl() {
  return process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, "") : null;
}

// Signs the recording links handed to Zoho as `voiceuri`. Falls back to a key
// derived from APP_SECRET, so links keep working across restarts either way.
const RECORDING_URL_SECRET = process.env.RECORDING_URL_SECRET ||
  crypto.createHmac("sha256", process.env.APP_SECRET).update("recording-url").digest("hex");
const RECORDING_URL_TTL_MS = Number(process.env.RECORDING_URL_TTL_DAYS || 30) * 24 * 60 * 60 * 1000;

// How long after a call ends to wait for its recording before logging the call
// to Zoho without audio.
const ZOHO_PB_RECORDING_GRACE_MS = Number(process.env.ZOHO_PB_RECORDING_GRACE_MS || 90_000);

// Send `missed` (with its mandatory start_time) for unanswered calls, falling
// back to `ended`/0s if Zoho refuses it. Off by default until confirmed on a
// live missed call.
const ZOHO_PB_SEND_MISSED_STATE = process.env.ZOHO_PB_SEND_MISSED_STATE === "true";

// Outbound calls are recorded unless OUTBOUND_RECORD=false. Read per call.
const outboundRecordEnabled = () => String(process.env.OUTBOUND_RECORD || "").trim().toLowerCase() !== "false";

// A click-to-dial handed to a softphone is bound to the next call that tab
// places to the same number within this window; anything else is a manual dial.
// A click that has not become a call by then is closed in Zoho as unanswered,
// so its call bar never hangs on "ringing". CLICK_TO_DIAL_TIMEOUT_MS tunes it.
const pendingClickWindowMs = () => Number(process.env.CLICK_TO_DIAL_TIMEOUT_MS) || 2 * 60 * 1000;

const MAX_BODY_BYTES = 64 * 1024;

// Vobiz webhooks must carry a valid signature unless this is explicitly
// "false" (the old verify-and-warn behaviour, for debugging a mismatch).
const signatureRequired = () => String(process.env.REQUIRE_VOBIZ_SIGNATURE || "").trim().toLowerCase() !== "false";

// The old sign-in, where an agent types the account's Auth Token into the
// softphone. Off unless explicitly turned on for a migration.
const agentTokenSignInAllowed = () => /^(1|true|yes)$/i.test(String(process.env.ALLOW_AGENT_AUTH_TOKEN || "").trim());

// ---------------------------------------------------------------------------
// Agent event stream
// ---------------------------------------------------------------------------

const callEventListeners = new Map(); // agentId -> Set<res>

// Click-to-dial calls handed to a softphone, waiting for Vobiz to tell us the
// CallUUID. Zoho needs one stable callId for the whole call, so the id is
// minted at click time and bound to the real UUID when /answer fires.
const pendingBrowserCalls = new Map();
// callId -> the timer that closes that click if it never becomes a call.
const pendingClickTimers = new Map();
// A waiting click -> its `ringing` notification to Zoho. Closing the click
// waits for it, so Zoho never gets `ended` before `ringing` and is left
// showing a call that rings forever.
const clickRingingSent = new WeakMap();

// agentId -> the id of the softphone tab that signed in last, which holds the
// agent's phone line.
const lineTabs = new Map();

function pushAgentEvent(agentId, event) {
  const listeners = callEventListeners.get(agentId);
  if (!listeners) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of listeners) res.write(payload);
}

/**
 * Vobiz keeps one registration per endpoint, so an agent has one live
 * softphone tab. When a tab signs in, every other open tab of that agent is
 * told it was signed in elsewhere: it stops its phone and its event stream,
 * and offers to sign in again there. Tabs are told apart by the id each one
 * sends with its sign-in and its event stream.
 */
function tellOtherTabs(agentId, signedInTab) {
  const listeners = callEventListeners.get(agentId);
  if (!listeners) return;
  const payload = `data: ${JSON.stringify({ type: "signed-in-elsewhere" })}\n\n`;
  for (const res of listeners) if (!signedInTab || res.vobizTab !== signedInTab) res.write(payload);
}

/** A tab id from the softphone: short, plain, or nothing. */
const tabIdOf = raw => (/^[A-Za-z0-9-]{8,64}$/.test(String(raw || "")) ? String(raw) : null);

/**
 * The event stream of the tab holding the agent's phone line — the tab that
 * signed in last — or null while that tab is not connected. Every other tab
 * of the agent was told it was signed in elsewhere, and its SIP password no
 * longer works, so a call handed to it could never be placed. For a page that
 * sends no tab id: the most recently connected stream (a Set iterates in
 * insertion order).
 */
function lineTabStream(agentId) {
  const listeners = callEventListeners.get(agentId);
  if (!listeners || !listeners.size) return null;
  const all = [...listeners];
  const lineTab = lineTabs.get(agentId);
  if (lineTab) return all.find(res => res.vobizTab === lineTab) || null;
  return all[all.length - 1];
}

/**
 * Click-to-dial goes to ONE tab, the one holding the phone line. Any other
 * open tab is told where the call went, so it is not a silent no-op there.
 */
function pushToLineTab(agentId, event, elsewhere) {
  const target = lineTabStream(agentId);
  if (!target) return;
  target.write(`data: ${JSON.stringify(event)}\n\n`);
  if (elsewhere) for (const res of callEventListeners.get(agentId)) if (res !== target) res.write(`data: ${JSON.stringify(elsewhere)}\n\n`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeXml(str) {
  return String(str == null ? "" : str).replace(/[<>&'"]/g, c => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  }[c]));
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(payload, null, 2));
}

function sendXml(res, xml) {
  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(xml);
}

const EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

/** Form-encoded (every Vobiz and Zoho webhook) or JSON (our own UI), size-capped. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      const type = String(req.headers["content-type"] || "");
      if (type.includes("json")) {
        try {
          return resolve(JSON.parse(raw));
        } catch {
          // Some clients send form data labelled JSON — fall through.
        }
      }
      resolve(Object.fromEntries(new URLSearchParams(raw)));
    });
    req.on("error", reject);
  });
}

/**
 * Inbound `To` arrives as "0XXXXXXXXXX", "91XXXXXXXXXX" or "+91XXXXXXXXXX";
 * only E.164 is usable as a callerId.
 */
function toE164(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (v.startsWith("+")) return v;
  if (v.startsWith("0") && v.length === 11) return `+91${v.slice(1)}`;
  return `+${v.replace(/\D/g, "")}`;
}

const callUuidOf = body => body.CallUUID || body.call_uuid || body.DialALegUUID || body.ALegRequestUUID || body.RequestUUID || null;

/** decodeURIComponent, but null instead of a throw on malformed %-encoding. */
function decodeSegment(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * The caller as the softphone shows it: the caller name when it is plain text
 * (letters, digits, spaces and . , ' ( ) + _ -), otherwise the E.164 number.
 * The name comes from the caller's side of the network, so nothing that could
 * be markup is ever passed on.
 */
function callerLabel(name, number) {
  const n = String(name || "").trim();
  if (/^[\p{L}\p{N} .,'()+_-]{1,40}$/u.test(n)) return n;
  return /^\+\d{6,15}$/.test(number) ? number : "unknown";
}

/**
 * A number Zoho asked us to dial: digits with an optional leading "+", once
 * spaces, dashes, dots and brackets are dropped. Anything else — letters,
 * markup — is not a phone number and is never handed to the softphone.
 */
function dialableNumber(raw) {
  const v = String(raw || "").trim();
  if (!/^\+?[\d\s().-]{3,32}$/.test(v)) return null;
  const digits = v.replace(/\D/g, "");
  if (digits.length < 3 || digits.length > 15) return null;
  return (v.startsWith("+") ? "+" : "") + digits;
}

/**
 * Content-Security-Policy for the softphone page: scripts only from this
 * origin plus the page's own inline script, pinned by its SHA-256 (computed
 * from the bytes being served, so it always matches them); network only to
 * this backend and the Vobiz SIP registrar. Even if something did slip markup
 * into the page, the browser would refuse to run it.
 */
function softphoneCsp(html) {
  const inline = [...String(html).matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${crypto.createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
  return [
    "default-src 'none'",
    `script-src 'self' ${inline.join(" ")}`.trim(),
    "style-src 'unsafe-inline'",
    "connect-src 'self' wss://registrar.vobiz.ai:5063",
    "media-src 'self' blob: mediastream:",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** The one place a failed request is answered and logged. */
function failRequest(req, res, err) {
  console.error(`[backend] ${req.method} ${String(req.url || "").split("?")[0]} failed:`, err);
  if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
  else res.end();
}

/**
 * Every account a webhook could belong to, most specific first: the account
 * of the browser that placed the call (by SIP username), the account Vobiz
 * names in ParentAuthID, the account of the call we are tracking, the account
 * that owns the dialled number, and last the authId our own callback URLs
 * carry. Only accounts whose token this backend holds are listed. Which one
 * the webhook really belongs to is decided by whose token verifies its
 * signature (authenticateWebhook) — never by a field an attacker controls.
 */
function webhookCandidates(body, url) {
  const out = [];
  const add = id => {
    if (id && !out.includes(id) && vobizAccounts.knownAccount(id)) out.push(id);
  };
  const bySip = vobizAccounts.sessionForSipFrom(body.From || body.from);
  if (bySip) add(bySip.authId);
  add(body.ParentAuthID || body.parentauthid);
  const tracked = zohoPhoneBridge.getTrackedCall(callUuidOf(body));
  if (tracked) add(tracked.authId);
  const byDid = vobizAccounts.accountForNumber(body.To || body.to);
  if (byDid) add(byDid.authId);
  add(url.searchParams.get("authId"));
  return out;
}

/**
 * A webhook for a SIP-direct agent: placed by a SIP-direct browser, to a
 * SIP-direct agent's number, or about a call one of them is on. This backend
 * holds no Auth Token for those, so their signature cannot be checked.
 */
function isSipDirectTraffic(body) {
  const bySip = vobizAccounts.sessionForSipFrom(body.From || body.from);
  if (bySip) return bySip.mode === "sip";
  if (vobizAccounts.sipDirectAgentsForNumber(body.To || body.to).length) return true;
  const tracked = zohoPhoneBridge.getTrackedCall(callUuidOf(body));
  // Never the ?agentId= of a callback URL: the query string is not signed.
  return Boolean(tracked && !tracked.authId);
}

// ---------------------------------------------------------------------------
// Vobiz webhook signature
// ---------------------------------------------------------------------------

/**
 * Vobiz signs every callback over the URL it was handed (query string
 * stripped) and a random nonce, never over the body:
 *   V3 = base64(HMAC-SHA256(authToken, url + "." + nonce))
 *   V2 = base64(HMAC-SHA256(authToken, url + nonce))
 * On a sub-account's callbacks it adds MA-V3 / MA-V2, the same signature made
 * with the parent (main) account's token, so an account connected as the
 * parent still verifies its sub-accounts' traffic. The URL is rebuilt from
 * PUBLIC_BASE_URL, since behind a proxy or tunnel the Host header is not what
 * Vobiz addressed. True when any of the four verifies with `authToken`.
 */
// Each signature with the nonce headers it may come with, most specific first;
// the plain X-Vobiz-Signature-Nonce is accepted as a last resort for each.
const SIGNATURE_HEADERS = [
  ["x-vobiz-signature-v3", ["x-vobiz-signature-v3-nonce", "x-vobiz-signature-nonce"], "."],
  ["x-vobiz-signature-ma-v3", ["x-vobiz-signature-ma-v3-nonce", "x-vobiz-signature-v3-nonce", "x-vobiz-signature-nonce"], "."],
  ["x-vobiz-signature-v2", ["x-vobiz-signature-v2-nonce", "x-vobiz-signature-nonce"], ""],
  ["x-vobiz-signature-ma-v2", ["x-vobiz-signature-ma-v2-nonce", "x-vobiz-signature-v2-nonce", "x-vobiz-signature-nonce"], ""],
];

function verifyVobizSignature(req, url, authToken) {
  const base = getPublicBaseUrl();
  if (!authToken || !base) return false;
  const signed = `${base}${url.pathname}`;
  return SIGNATURE_HEADERS.some(([sigHeader, nonceHeaders, sep]) => {
    const sig = req.headers[sigHeader];
    const nonce = nonceHeaders.map(h => req.headers[h]).find(Boolean);
    if (!sig || !nonce) return false;
    const expected = crypto.createHmac("sha256", authToken).update(`${signed}${sep}${nonce}`).digest("base64");
    const a = Buffer.from(String(sig));
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

/**
 * Decide whether a Vobiz webhook may act, and for which account.
 *
 * The account is the candidate whose token verifies the signature. Handlers
 * act for that account only, so a webhook signed with one customer's token
 * can never reach another customer's agents, calls or Zoho log, whatever its
 * body or query string say.
 *
 * Refused, by default, when no candidate's token verifies it. Two exceptions:
 *   - SIP-direct traffic for which this backend holds no token at all is
 *     accepted unverified, because there is nothing to verify it with — the
 *     README says so, and connecting that account as admin makes it checked;
 *   - REQUIRE_VOBIZ_SIGNATURE=false accepts everything with a warning, the
 *     old behaviour, for debugging a signature mismatch.
 */
function authenticateWebhook(req, url, body) {
  const candidates = webhookCandidates(body, url);
  for (const authId of candidates) {
    if (verifyVobizSignature(req, url, vobizAccounts.tokenFor(authId))) {
      console.log(`[backend] ${url.pathname} signature ok (${authId})`);
      return { ok: true, authId };
    }
  }
  if (!signatureRequired()) {
    console.warn(`[backend] ${url.pathname} signature missing or wrong — accepted (REQUIRE_VOBIZ_SIGNATURE=false)`);
    return { ok: true, authId: candidates[0] || null };
  }
  if (!candidates.length && isSipDirectTraffic(body)) {
    console.warn(`[backend] ${url.pathname} SIP-direct webhook accepted unverified — this backend holds no Auth Token for it`);
    return { ok: true, authId: null };
  }
  console.warn(`[backend] ${url.pathname} signature missing or wrong — refused (${candidates.length ? `checked against ${candidates.join(", ")}` : "no connected or signed-in Vobiz account to check it against"})`);
  return { ok: false, authId: null };
}

// ---------------------------------------------------------------------------
// VobizXML
// ---------------------------------------------------------------------------

/**
 * The agent's browser dialled out, so it is the A leg and the customer is the
 * B leg. This is the direction that works: routing *into* a registered WebRTC
 * endpoint with <Dial><User> is not used anywhere in the outbound path.
 *
 * callbackUrl reports DialAnswer the moment the customer picks up — the only
 * place that moment is visible, since /answer fired when the browser's own
 * leg was answered.
 */
function vobizXmlDialCustomer(to, callerId, agentId, authId, publicBaseUrl) {
  // Same raw "&" in the attribute as the inbound XML that has run live.
  const qs = `agentId=${encodeURIComponent(agentId)}&authId=${encodeURIComponent(authId)}`;
  const callerIdAttr = callerId ? ` callerId="${escapeXml(callerId)}"` : "";
  // <Record> is a sibling before <Dial>, never nested. OUTBOUND_RECORD=false
  // drops it; the call log then lands from /dial-result without audio.
  const record = outboundRecordEnabled()
    ? `  <Record recordSession="true" redirect="false" playBeep="false" fileFormat="mp3"\n    callbackUrl="${publicBaseUrl}/recording-ready?${qs}" callbackMethod="POST"/>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${record}  <Dial${callerIdAttr} timeout="30" timeLimit="14400" redirect="false" method="POST"
    action="${publicBaseUrl}/dial-result?${qs}"
    callbackUrl="${publicBaseUrl}/dial-event?${qs}" callbackMethod="POST">
    <Number>${escapeXml(String(to).replace(/^\+/, ""))}</Number>
  </Dial>
  <Hangup/>
</Response>`;
}

/**
 * A customer called a DID on a signed-in account. Rings every signed-in agent
 * of that account at once, with callerId set to the DID that was dialled —
 * without it Vobiz derives the B leg's caller ID from the caller's own number,
 * which the account does not own, and never creates the B leg.
 */
function vobizXmlInboundToAgents(agents, authId, publicBaseUrl, dialedNumber) {
  const qs = `agentId=${encodeURIComponent(agents[0].agentId)}&authId=${encodeURIComponent(authId)}&dir=in`;
  const callerIdAttr = dialedNumber ? ` callerId="${escapeXml(toE164(dialedNumber))}"` : "";
  const destinations = agents.map(a => `    <User>sip:${escapeXml(a.sipUser)}@registrar.vobiz.ai</User>`);
  // <Record> is a sibling before <Dial>, never nested.
  const inboundRecord = process.env.INBOUND_RECORD === "true"
    ? `  <Record recordSession="true" redirect="false" playBeep="false" fileFormat="mp3"\n    callbackUrl="${publicBaseUrl}/recording-ready?${qs}" callbackMethod="POST"/>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${inboundRecord}  <Dial${callerIdAttr} timeout="20" redirect="false" method="POST"
    action="${publicBaseUrl}/dial-result?${qs}"
    callbackUrl="${publicBaseUrl}/dial-event?${qs}" callbackMethod="POST">
${destinations.join("\n")}
  </Dial>
  <Speak>Sorry, no one is available to take your call right now. Please leave a message after the beep.</Speak>
  <Record maxLength="120" timeout="10" finishOnKey="#" playBeep="true" fileFormat="mp3"
    callbackUrl="${publicBaseUrl}/recording-ready?${qs}" callbackMethod="POST"/>
  <Speak>Thank you. Goodbye.</Speak>
  <Hangup/>
</Response>`;
}

// ---------------------------------------------------------------------------
// Vobiz REST
// ---------------------------------------------------------------------------

const vobizHeadersFor = authId => ({ "X-Auth-ID": authId, "X-Auth-Token": vobizAccounts.tokenFor(authId) });

/**
 * Billed duration from the CDR. For a browser-originated call the browser's
 * own leg is billed from before the customer even rang, so the B leg — the
 * customer, or the agent on an inbound call — is what is asked for.
 */
async function fetchVobizBilledDuration(authId, callUuid) {
  if (!vobizAccounts.tokenFor(authId) || !callUuid) return null;
  try {
    const res = await fetch(
      `https://api.vobiz.ai/api/v1/Account/${encodeURIComponent(authId)}/Call/${encodeURIComponent(callUuid)}/`,
      { headers: vobizHeadersFor(authId), signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const cdr = await res.json();
    const billed = Number(cdr.bill_duration);
    return Number.isFinite(billed) && billed >= 0 ? billed : null;
  } catch (err) {
    console.warn(`[zoho-pb] could not read the CDR for ${callUuid}: ${err.message}`);
    return null;
  }
}

/**
 * Streams a recording, fetched server-side on the credentials of the account
 * the signed link names. Only reachable through the HMAC-signed
 * /zoho/phonebridge/recording link; takes a recording id, never a URL.
 */
async function streamRecording(res, authId, recordingId) {
  if (!vobizAccounts.tokenFor(authId)) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    return res.end("this recording's Vobiz account is not signed in on this backend since it restarted — an agent of that account must sign in again");
  }
  const metaRes = await fetch(
    `https://api.vobiz.ai/api/v1/Account/${encodeURIComponent(authId)}/Recording/${encodeURIComponent(recordingId)}/`,
    { headers: vobizHeadersFor(authId) },
  );
  if (!metaRes.ok) {
    res.writeHead(metaRes.status === 404 ? 404 : 502, { "Content-Type": "text/plain" });
    return res.end("recording not found");
  }
  const meta = await metaRes.json();
  const fileUrl = meta.recording_url;
  // The file must come from Vobiz, over HTTPS — never follow a URL anywhere
  // else, or in the clear, with the account credentials attached.
  let host = "";
  let secure = false;
  try {
    const parsed = new URL(fileUrl);
    host = parsed.hostname;
    secure = parsed.protocol === "https:";
  } catch { /* fall through */ }
  if (!secure || !host || !(host === "vobiz.ai" || host.endsWith(".vobiz.ai"))) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("no recording file yet");
  }
  const fileRes = await fetch(fileUrl, { headers: vobizHeadersFor(authId) });
  if (!fileRes.ok || !fileRes.body) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    return res.end("could not fetch the recording file");
  }
  res.writeHead(200, {
    "Content-Type": meta.recording_format === "wav" ? "audio/wav" : "audio/mpeg",
    "Cache-Control": "private, max-age=3600",
  });
  const reader = fileRes.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

// ---------------------------------------------------------------------------
// Vobiz webhooks
// ---------------------------------------------------------------------------

// What a caller hears when a call cannot go through — never silence.
const CANNOT_CONNECT_XML = `<?xml version="1.0" encoding="UTF-8"?><Response><Speak>This call cannot be connected right now.</Speak><Hangup/></Response>`;
const NOBODY_AVAILABLE_XML = `<?xml version="1.0" encoding="UTF-8"?><Response><Speak>Sorry, no one is available to take your call right now. Please try again later.</Speak><Hangup/></Response>`;

/**
 * The reply to a refused /answer. Static and polite: it acts on nothing and
 * reveals nothing, so it is safe to give an unverified request, and a real
 * caller whose webhook could not be verified still hears a message.
 */
const refusedAnswerXml = body => (String(body.From || body.from || "").startsWith("sip:") ? CANNOT_CONNECT_XML : NOBODY_AVAILABLE_XML);

/**
 * The answer_url of the application provisioned in each signed-in account.
 * Two kinds of call reach it:
 *   - the agent's browser dialled out (From=sip:<user>@…): dial the customer
 *     with the caller ID the agent picked from that account's numbers;
 *   - a PSTN caller dialled a DID attached by "Enable inbound calls": ring the
 *     signed-in agents of the account that owns the DID.
 */
async function handleAnswer(req, res, url) {
  const body = await readBody(req).catch(() => ({}));
  const { ok, authId } = authenticateWebhook(req, url, body);
  if (!ok) return sendXml(res, refusedAnswerXml(body));

  // Vobiz posts the end-of-call notification here when no hangup_url is set.
  // Acknowledge it; never answer it with call instructions.
  if ((body.Event || "") === "Hangup") return sendXml(res, EMPTY_XML);

  const from = String(body.From || body.from || "");
  const routeType = String(body.RouteType || body.routetype || "").toLowerCase();
  const browserLeg = from.startsWith("sip:") || routeType === "sip";
  if (!browserLeg) return answerInbound(body, res, authId);

  const session = vobizAccounts.sessionForSipFrom(from);
  const publicBaseUrl = getPublicBaseUrl();
  if (!session || !publicBaseUrl) {
    console.warn(`[backend] /answer — no signed-in agent for from=${from}; the agent must sign in to Vobiz from the softphone again`);
    return sendXml(res, CANNOT_CONNECT_XML);
  }
  // The signature names the account. A browser signed in on one account is
  // never dialled out for by a webhook another account's token signed.
  if (session.mode === "account" && session.authId !== authId) {
    console.warn(`[backend] /answer — ${session.agentId} is on ${session.authId}, but the webhook was signed for ${authId || "no account"}; refused`);
    return sendXml(res, CANNOT_CONNECT_XML);
  }
  const { agentId } = session;
  const callUuid = body.CallUUID || body.call_uuid || body.RequestUUID;
  const customer = body.To || body.to;
  console.log(`[backend] /answer — ${agentId}'s browser is the A leg (${session.authId || "SIP direct"}), dialling ${customer}`);
  // A click-to-dial waiting for this tab is bound only to a call to the same
  // number, placed soon after the click. Any other call is a number the agent
  // typed by hand, logged further down once the caller ID is known.
  let manualDial = false;
  let boundClick = false;
  if (callUuid && !zohoPhoneBridge.getTrackedCall(callUuid)) {
    const pending = pendingBrowserCalls.get(agentId);
    const fresh = pending && Date.now() - pending.createdAtMs < pendingClickWindowMs();
    if (pending && !fresh) closePendingClick(agentId, pending.callId, "it was not dialled in time");
    if (fresh && sameNumber(pending.to, customer)) {
      forgetPendingClick(agentId);
      zohoPhoneBridge.trackCall(callUuid, { ...pending, authId: session.authId, startedAtMs: Date.now() });
      boundClick = true;
      console.log(`[zoho-pb] bound ${pending.callId} to CallUUID ${callUuid}`);
    } else {
      manualDial = true;
    }
  }
  // X-VH-Caller-ID on the INVITE (the panel sets it) wins over the caller ID
  // recorded at sign-in, when it is a valid number the session may use.
  const vh = Object.entries(body).find(([k]) => /^(SIPHeader_)?X-VH-Caller-ID$/i.test(k));
  const fromHeader = vh ? vobizAccounts.headerCallerId(session, vh[1]) : null;
  if (vh && !fromHeader) console.warn(`[backend] /answer — ignoring X-VH-Caller-ID "${vh[1]}" for ${agentId}: not a usable number`);
  if (fromHeader) session.callerId = fromHeader;
  if (!session.callerId) {
    // Without callerId Vobiz derives it from the A leg — here a SIP username,
    // not a number — and never creates the customer leg.
    console.warn(`[backend] /answer — ${agentId} has no caller ID; their Vobiz account has no numbers`);
    // No <Dial>, so no dial result will ever close the click in Zoho: close
    // it now, as unanswered.
    if (boundClick) finalizeZohoPhoneBridgeCall(callUuid).catch(err => console.error("[zoho-pb] closing an undialled call failed:", err.message));
    return sendXml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Speak>This line has no caller ID configured.</Speak><Hangup/></Response>`);
  }
  if (manualDial) trackManualDial(callUuid, agentId, session, customer);
  return sendXml(res, vobizXmlDialCustomer(customer, session.callerId, agentId, session.authId || "", publicBaseUrl));
}

const sameNumber = (a, b) => {
  const da = String(a || "").replace(/\D/g, "");
  const db = String(b || "").replace(/\D/g, "");
  return Boolean(da) && da === db;
};

/**
 * A number the agent typed into the softphone. Logged in Zoho exactly like a
 * click-to-dial call — dialed/ringing now, answered and ended from the same
 * webhooks — against the Zoho user the agent is mapped to. An agent with no
 * Zoho user in any connected org is not logged.
 */
function trackManualDial(callUuid, agentId, session, customer) {
  const orgId = zohoPhoneBridge.orgForAgent(agentId);
  const org = orgId && zohoPhoneBridge.getOrg(orgId);
  const zohoUser = (org && org.agentMap && org.agentMap[agentId]) || null;
  if (!zohoUser) {
    console.log(`[zoho-pb] manual dial by ${agentId} not logged — the agent is not mapped to a Zoho user`);
    return;
  }
  const tracked = zohoPhoneBridge.trackCall(callUuid, {
    orgId, callId: `vobiz-manual-${callUuid}`, agentId, authId: session.authId, zohoUser,
    type: "dialed", from: session.callerId, to: toE164(customer), startedAtMs: Date.now(), manual: true,
  });
  console.log(`[zoho-pb] logging manual dial ${tracked.callId} by ${agentId} to ${tracked.to}`);
  zohoPhoneBridge.notifyCall({
    orgId, type: "dialed", state: "ringing", callId: tracked.callId,
    from: tracked.from, to: tracked.to, zohoUser, credentials: pbCredentials(),
  }).catch(err => console.error("[zoho-pb] manual dial ringing notify failed:", err.message));
}

/** hangup_url of the provisioned application: acknowledge, nothing else. */
async function handleHangup(req, res, url) {
  const body = await readBody(req).catch(() => ({}));
  authenticateWebhook(req, url, body);
  sendXml(res, EMPTY_XML);
}

/** Report `answered` once per call. Vobiz can fetch an answer URL twice. */
function markAnswered(callUuid, extra = {}) {
  const tracked = callUuid && zohoPhoneBridge.getTrackedCall(callUuid);
  if (!tracked) return;
  if (tracked.answeredAtMs) {
    console.log(`[zoho-pb] ${tracked.callId} already answered — not reporting it twice`);
    return;
  }
  zohoPhoneBridge.updateTrackedCall(callUuid, { answeredAtMs: Date.now(), ...extra });
  zohoPhoneBridge.notifyCall({
    orgId: tracked.orgId, type: tracked.type, state: "answered",
    callId: tracked.callId, from: tracked.from, to: tracked.to,
    zohoUser: tracked.zohoUser, credentials: pbCredentials(),
  }).catch(err => console.error("[zoho-pb] answered notify failed:", err.message));
}

/** A tracked call is only touched by a webhook from the account that owns it. */
function trackedFor(callUuid, authId) {
  const tracked = callUuid && zohoPhoneBridge.getTrackedCall(callUuid);
  if (!tracked) return null;
  if (tracked.authId && tracked.authId !== authId) {
    console.warn(`[backend] webhook for ${callUuid} came from account ${authId}, not ${tracked.authId} — ignored`);
    return null;
  }
  return tracked;
}

/**
 * An inbound call rings every signed-in agent of the account; the call log
 * belongs to the one who answered. Attributes the tracked call to `agentId`
 * when that agent was one of those rung and is mapped to a Zoho user in the
 * org the call is logged in. The first attribution wins: DialBLegTo on the
 * Dial callback when Vobiz names the leg, else the softphone's own report.
 */
function attributeInboundTo(callUuid, agentId, how) {
  const tracked = callUuid && agentId && zohoPhoneBridge.getTrackedCall(callUuid);
  if (!tracked || tracked.type !== "received") return false;
  if (!(tracked.ringingAgents || []).some(a => a.agentId === agentId)) return false;
  if (tracked.answeredBy) return tracked.answeredBy === agentId;
  const org = zohoPhoneBridge.getOrg(tracked.orgId);
  const zohoUser = (org && org.agentMap && org.agentMap[agentId]) || null;
  const patch = { answeredBy: agentId };
  if (zohoUser) {
    patch.agentId = agentId;
    patch.zohoUser = zohoUser;
  } else {
    console.warn(`[zoho-pb] ${tracked.callId} answered by ${agentId}, who has no Zoho user in ${tracked.orgId} — logged against ${tracked.agentId}`);
  }
  zohoPhoneBridge.updateTrackedCall(callUuid, patch);
  console.log(`[zoho-pb] ${tracked.callId} answered by ${agentId} (${how})`);
  return true;
}

/** "sip:zohopriya123@registrar.vobiz.ai" -> the ringing agent with that SIP user. */
function answererFromDialEvent(tracked, body) {
  const m = String(body.DialBLegTo || "").trim().match(/^(?:sips?:)?([^@;>\s]+)/i);
  if (!m) return null;
  const user = m[1].toLowerCase();
  const hit = (tracked.ringingAgents || []).find(a => String(a.sipUser || "").toLowerCase() === user);
  return hit ? hit.agentId : null;
}

/** Dial callbackUrl: DialAnswer is the moment the B leg picked up. */
async function handleDialEvent(req, res, url) {
  const body = await readBody(req).catch(() => ({}));
  const { ok, authId } = authenticateWebhook(req, url, body);
  if (!ok) return sendXml(res, EMPTY_XML);
  const event = String(body.Event || "");
  const action = String(body.DialAction || "").toLowerCase();
  const callUuid = body.CallUUID || body.DialALegUUID;
  const tracked = (event === "DialAnswer" || action === "answer") && trackedFor(callUuid, authId);
  if (tracked) {
    if (tracked.type === "received") {
      const answerer = answererFromDialEvent(tracked, body);
      if (answerer) attributeInboundTo(callUuid, answerer, "DialBLegTo");
    }
    markAnswered(callUuid, body.DialBLegUUID ? { bLegUuid: body.DialBLegUUID } : {});
  }
  sendXml(res, EMPTY_XML);
}

/**
 * Dial `action` with redirect="false": answer with an empty <Response>, or
 * Vobiz re-runs a flow that has already moved on.
 */
async function handleDialResult(req, res, url) {
  const body = await readBody(req).catch(() => ({}));
  const { ok, authId } = authenticateWebhook(req, url, body);
  if (!ok) return sendXml(res, EMPTY_XML);
  console.log(`[backend] dial finished — DialStatus=${body.DialStatus} DialHangupCause=${body.DialHangupCause}`);
  const callUuid = body.CallUUID || body.DialALegUUID || body.RequestUUID;
  // The agent comes from what this backend knows about the call — the
  // browser's SIP user, or the tracked call — never from ?agentId=, which is
  // not covered by the signature.
  const bySip = vobizAccounts.sessionForSipFrom(body.From || body.from);
  const tracked = zohoPhoneBridge.getTrackedCall(callUuid);
  const agentId = (bySip && bySip.agentId) || (tracked && tracked.agentId) || null;
  const session = agentId && vobizAccounts.sessionFor(agentId);
  if (session && session.authId === authId) pushAgentEvent(agentId, { type: "call-ended", status: body.DialStatus });

  // Safety net: the recording webhook is the preferred place to close a call
  // (it carries the audio), but a call with no recording never produces one.
  // finalize is idempotent, so whichever arrives first wins.
  if (trackedFor(callUuid, authId)) {
    if (body.DialBLegUUID) zohoPhoneBridge.updateTrackedCall(callUuid, { bLegUuid: body.DialBLegUUID });
    setTimeout(() => {
      finalizeZohoPhoneBridgeCall(callUuid).catch(err => console.error("[zoho-pb] fallback finalize failed:", err.message));
    }, ZOHO_PB_RECORDING_GRACE_MS).unref();
  }
  sendXml(res, EMPTY_XML);
}

async function handleRecordingReady(req, res, url) {
  const body = await readBody(req).catch(() => ({}));
  const { ok, authId } = authenticateWebhook(req, url, body);
  if (!ok) return sendJson(res, 200, { received: false });
  sendJson(res, 200, { received: true });

  // Any call Zoho is tracking — browser-originated or inbound. Keyed on the
  // call, not on which route placed it.
  const callUuid = body.CallUUID || body.ALegRequestUUID;
  if (trackedFor(callUuid, authId)) {
    finalizeZohoPhoneBridgeCall(callUuid, {
      recordingId: body.RecordingID || body.recording_id,
      durationSec: Number(body.RecordingDuration || body.recording_duration || 0) || null,
    }).catch(err => console.error("[zoho-pb] final call log failed:", err.message));
  }
}

/**
 * Kept for numbers still pointed at <PUBLIC_BASE_URL>/inbound-answer by hand.
 * ?agentId= is ignored: the account and its agents come from the dialled DID,
 * exactly as on /answer.
 */
async function handleInboundAnswer(req, res, url) {
  const body = await readBody(req).catch(() => ({}));
  const { ok, authId } = authenticateWebhook(req, url, body);
  if (!ok) return sendXml(res, refusedAnswerXml(body));
  if ((body.Event || "") === "Hangup") return sendXml(res, EMPTY_XML);
  return answerInbound(body, res, authId);
}

/**
 * PSTN caller -> DID: ring the signed-in agents of `authId`, the account
 * whose token verified this webhook. With no account (SIP direct, which has
 * no token), only SIP-direct agents whose number was dialled ring. Nothing in
 * the body — ParentAuthID, To — can point the call at another account's agents.
 */
function answerInbound(body, res, authId) {
  const callUuid = body.CallUUID || body.call_uuid || null;
  const caller = toE164(body.From || body.from);
  const dialled = toE164(body.To || body.to);
  let match = null;
  if (authId) {
    const owner = vobizAccounts.accountForNumber(dialled);
    match = {
      authId,
      number: owner && owner.authId === authId ? owner.number : dialled,
      agents: vobizAccounts.agentsForAccount(authId),
    };
  } else {
    const agents = vobizAccounts.sipDirectAgentsForNumber(dialled);
    if (agents.length) match = { authId: null, number: agents[0].inboundNumber, agents };
  }
  const publicBaseUrl = getPublicBaseUrl();
  if (!match || !match.agents.length || !publicBaseUrl) {
    console.warn(`[backend] inbound ${caller} -> ${dialled}: ${!match ? "no signed-in Vobiz account or SIP-direct agent owns this number" : "no agent of " + match.authId + " is signed in"} — hanging up politely`);
    return sendXml(res, NOBODY_AVAILABLE_XML);
  }
  const agentIds = match.agents.map(a => a.agentId);
  console.log(`[backend] inbound call ${caller} -> ${dialled} (${match.authId || "SIP direct"}), ringing ${agentIds.join(", ")}`);
  // Only a plain caller name or the number reaches the softphone, and the
  // call id only if it looks like one.
  const routedFrom = callerLabel(body.CallerName, caller);
  const routedUuid = /^[A-Za-z0-9-]{1,64}$/.test(String(callUuid || "")) ? callUuid : null;
  for (const agentId of agentIds) {
    pushAgentEvent(agentId, { type: "inbound-routed", from: routedFrom, callUuid: routedUuid });
  }

  // The call is tracked under the first ringing agent that belongs to a
  // connected org: that user gets the ringing pop-up, and an unanswered call
  // is logged as missed against them. When an agent answers, the log moves to
  // the agent who answered (attributeInboundTo).
  const loggedAgent = agentIds.find(id => zohoPhoneBridge.orgForAgent(id));
  const ordered = [match.agents.find(a => a.agentId === loggedAgent), ...match.agents.filter(a => a.agentId !== loggedAgent)].filter(Boolean);
  if (loggedAgent && callUuid && !zohoPhoneBridge.getTrackedCall(callUuid)) {
    const orgId = zohoPhoneBridge.orgForAgent(loggedAgent);
    const org = zohoPhoneBridge.getOrg(orgId);
    const zohoUser = (org && org.agentMap && org.agentMap[loggedAgent]) || null;
    const tracked = zohoPhoneBridge.trackCall(callUuid, {
      orgId, callId: `vobiz-in-${callUuid}`, agentId: loggedAgent, authId: match.authId, zohoUser,
      type: "received", from: caller, to: dialled, startedAtMs: Date.now(),
      ringingAgents: ordered.map(a => ({ agentId: a.agentId, sipUser: a.sipUser })),
    });
    zohoPhoneBridge.notifyCall({
      orgId, type: "received", state: "ringing", callId: tracked.callId,
      from: caller, to: dialled, zohoUser, credentials: pbCredentials(),
    }).catch(err => console.error("[zoho-pb] inbound ringing notify failed:", err.message));
  }

  sendXml(res, vobizXmlInboundToAgents(ordered, match.authId || "", publicBaseUrl, match.number));
}

// ---------------------------------------------------------------------------
// Zoho PhoneBridge
// ---------------------------------------------------------------------------

/** The authId is inside the signed payload: a link for one account never fetches another's audio. */
function signRecordingToken(authId, agentId, recordingId, expiresAtMs) {
  return crypto.createHmac("sha256", RECORDING_URL_SECRET)
    .update(`${authId}.${agentId}.${recordingId}.${expiresAtMs}`).digest("hex");
}

function buildSignedRecordingUrl(authId, agentId, recordingId, publicBaseUrl) {
  const expiresAt = Date.now() + RECORDING_URL_TTL_MS;
  const sig = signRecordingToken(authId, agentId, recordingId, expiresAt);
  const qs = new URLSearchParams({ authId, agentId: agentId || "", recordingId, expires: String(expiresAt), sig });
  return `${publicBaseUrl}/zoho/phonebridge/recording?${qs.toString()}`;
}

async function handleZohoPbRecording(req, res, url) {
  const authId = url.searchParams.get("authId") || "";
  const agentId = url.searchParams.get("agentId") || "";
  const recordingId = url.searchParams.get("recordingId");
  const expires = Number(url.searchParams.get("expires") || 0);
  const sig = url.searchParams.get("sig") || "";
  if (!authId || !recordingId || !expires || Date.now() > expires) {
    res.writeHead(410, { "Content-Type": "text/plain" });
    return res.end("recording link missing or expired");
  }
  const expected = signRecordingToken(authId, agentId, recordingId, expires);
  if (!(sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("bad signature");
  }
  await streamRecording(res, authId, recordingId);
}

function pbConfigured() {
  return Boolean(ZOHO_PB_CLIENT_ID && ZOHO_PB_CLIENT_SECRET && ZOHO_PB_REDIRECT_URI);
}

/** Admin: start the consent flow, for a new org or (?orgId=) to re-authorize one. */
async function handleZohoPbConnect(req, res, url) {
  if (!pbConfigured()) {
    return sendJson(res, 500, {
      error: "Zoho PhoneBridge is not configured",
      hint: "set ZOHO_PB_CLIENT_ID, ZOHO_PB_CLIENT_SECRET and ZOHO_PB_REDIRECT_URI",
    });
  }
  const requested = url.searchParams.get("orgId");
  if (requested && !zohoPhoneBridge.getOrg(requested)) return sendJson(res, 404, { error: `no org '${requested}' to re-authorize` });
  // Our own id for the tenant. Every connect without ?orgId= is a new tenant,
  // so a second customer can never overwrite the first one's grant.
  const orgId = requested || `org_${crypto.randomBytes(8).toString("hex")}`;

  // ?dc=in starts consent at a single datacentre, for a client registered
  // there without Multi-DC.
  const dc = url.searchParams.get("dc");
  let accountsDomain = null;
  if (dc) {
    try {
      accountsDomain = await zohoPhoneBridge.accountsDomainForLocation(dc);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  const authUrl = zohoPhoneBridge.buildAuthUrl({
    clientId: ZOHO_PB_CLIENT_ID,
    redirectUri: ZOHO_PB_REDIRECT_URI,
    state: auth.mintOAuthState(orgId),
    accountsDomain,
  });
  console.log(`[zoho-pb] starting consent for ${orgId} at ${accountsDomain || "https://accounts.zoho.com"}`);
  res.writeHead(302, { Location: authUrl });
  res.end();
}

async function resolveLocation(location, accountsServer) {
  if (location) return location;
  if (!accountsServer) return null;
  const locations = await zohoPhoneBridge.resolveServerInfo();
  const norm = d => String(d).replace(/\/+$/, "").toLowerCase();
  return Object.keys(locations).find(k => norm(locations[k]) === norm(accountsServer)) || null;
}

/** Shared by the redirect callback and the paste-the-URL completion page. */
async function completeAuthorization(params) {
  const oauthError = params.get("error");
  if (oauthError) return { status: 400, body: { error: `Zoho returned an error: ${oauthError}` } };
  const orgId = auth.readOAuthState(params.get("state"));
  if (!orgId) {
    return { status: 400, body: { error: "missing, forged or expired 'state' — start again from /zoho/phonebridge/connect" } };
  }
  const code = params.get("code");
  if (!code) return { status: 400, body: { error: "no 'code' returned" } };
  const accountsServer = params.get("accounts-server");
  const location = await resolveLocation(params.get("location"), accountsServer);
  if (!location) {
    return { status: 400, body: { error: "Zoho returned neither 'location' nor a recognisable 'accounts-server'; refusing to guess the datacentre" } };
  }
  let tokens;
  try {
    tokens = await zohoPhoneBridge.exchangeCodeForTokens({
      code, location,
      clientId: ZOHO_PB_CLIENT_ID,
      clientSecret: ZOHO_PB_CLIENT_SECRET,
      redirectUri: ZOHO_PB_REDIRECT_URI,
    });
  } catch (err) {
    return { status: 502, body: { error: err.message, hint: "codes last about a minute — start the connect flow again" } };
  }
  const existing = zohoPhoneBridge.getOrg(orgId);
  zohoPhoneBridge.saveOrg(orgId, {
    ...tokens,
    // A re-authorization without a new refresh token keeps the old one.
    refreshToken: tokens.refreshToken || (existing && existing.refreshToken) || null,
    connectedAt: (existing && existing.connectedAt) || new Date().toISOString(),
    accountsServer: accountsServer || tokens.accountsDomain,
  });
  console.log(`[zoho-pb] connected org ${orgId} — location=${location} api=${tokens.apiDomain}`);
  return {
    status: 200,
    body: {
      message: "Connected to Zoho PhoneBridge",
      orgId, location, apiDomain: tokens.apiDomain, scope: tokens.scope,
      nextStep: `POST /zoho/phonebridge/register with {"orgId":"${orgId}"} (admin)`,
    },
  };
}

async function handleZohoPbCallback(req, res, url) {
  const result = await completeAuthorization(url.searchParams);
  sendJson(res, result.status, result.body);
}

/**
 * Admin fallback for when the registered redirect URI points at a host that is
 * not this backend: paste the URL Zoho redirected to and the exchange completes
 * here. Not a customer flow — the real fix is serving ZOHO_PB_REDIRECT_URI.
 */
function handleZohoPbCompleteForm(req, res) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Finish connecting Zoho</title>
<style>:root{color-scheme:light dark}body{font:15px/1.6 system-ui,sans-serif;max-width:680px;margin:0 auto;padding:32px 16px}
textarea{width:100%;box-sizing:border-box;height:110px;font:13px/1.5 ui-monospace,monospace;padding:10px}
button{margin-top:12px;padding:10px 18px;font-size:15px}</style>
<h1>Finish connecting Zoho</h1>
<p>Only needed when the redirect URI registered with Zoho is not served by this backend.
Paste the whole URL Zoho redirected you to, within a minute of approving.</p>
<form method="POST"><textarea name="callbackUrl" autofocus></textarea><button type="submit">Connect</button></form>`);
}

async function handleZohoPbComplete(req, res) {
  const body = await readBody(req).catch(() => ({}));
  const pasted = String(body.callbackUrl || body.url || "").trim();
  if (!pasted) return sendJson(res, 400, { error: "No URL supplied" });
  let parsed;
  try {
    parsed = new URL(pasted.startsWith("http") ? pasted : `https://placeholder.invalid/?${pasted.replace(/^\?/, "")}`);
  } catch {
    return sendJson(res, 400, { error: "That doesn't parse as a URL" });
  }
  const result = await completeAuthorization(parsed.searchParams);
  sendJson(res, result.status, result.body);
}

function clickToDialUriFor(orgId, agentId, publicBaseUrl) {
  const qs = new URLSearchParams({ orgId, agentId, t: auth.clickToDialToken(orgId, agentId) });
  return `${publicBaseUrl}/zoho/phonebridge/clicktodial?${qs.toString()}`;
}

/**
 * Admin: activate the PBX, read the org's Zoho users, pair them with agents
 * (agents.json `zohoUser` or `email`), and register one click-to-dial URI per
 * paired user. `defaultAgentId`, when given, also registers an org-level URI
 * for that agent — the one-agent setup this used to be limited to.
 */
async function handleZohoPbRegister(req, res) {
  const body = await readBody(req).catch(() => ({}));
  const { orgId, defaultAgentId } = body;
  const publicBaseUrl = getPublicBaseUrl();
  if (!orgId || !zohoPhoneBridge.getOrg(orgId)) return sendJson(res, 400, { error: `unknown orgId '${orgId}'` });
  if (defaultAgentId && !getAgent(defaultAgentId)) return sendJson(res, 400, { error: `unknown defaultAgentId '${defaultAgentId}'` });
  if (!publicBaseUrl) return sendJson(res, 500, { error: "PUBLIC_BASE_URL is not set — Zoho needs a reachable URL" });

  // Zoho rejects everything with PBX_NOT_INTEGRATED until this has run once.
  const integration = await zohoPhoneBridge.integrate({ orgId, credentials: pbCredentials() });
  if (!integration.ok) {
    return sendJson(res, 502, {
      registered: false, step: "integrate", zohoResponse: integration.body,
      hint: "Confirm Vobiz Telephony is installed for this org in Zoho Marketplace > Telephony.",
    });
  }

  const zohoUsers = await zohoPhoneBridge.listZohoUsers({ orgId, credentials: pbCredentials() });
  const { map, unmatchedAgents, unmatchedZohoUsers } = matchAgentsToZohoUsers(loadAgents(), zohoUsers);

  const registrations = [];
  const failures = [];
  for (const [agentId, zohoUser] of Object.entries(map)) {
    const r = await zohoPhoneBridge.registerClickToDial({
      orgId, zohoUser, clickToDialUri: clickToDialUriFor(orgId, agentId, publicBaseUrl), credentials: pbCredentials(),
    });
    (r.ok ? registrations : failures).push({ agentId, zohoUser, ...(r.ok ? {} : { zohoResponse: r.body }) });
  }
  if (defaultAgentId) {
    const r = await zohoPhoneBridge.registerClickToDial({
      orgId, clickToDialUri: clickToDialUriFor(orgId, defaultAgentId, publicBaseUrl), credentials: pbCredentials(),
    });
    (r.ok ? registrations : failures).push({ agentId: defaultAgentId, zohoUser: null, ...(r.ok ? {} : { zohoResponse: r.body }) });
  }
  if (registrations.length === 0 && failures.length === 0) {
    return sendJson(res, 400, {
      registered: false,
      error: "no agent in agents.json matches a Zoho user, and no defaultAgentId was given",
      zohoUsers: zohoUsers.map(u => ({ zohouser: u.zohouser, email: u.email, username: u.username })),
      hint: "set `zohoUser` or `email` on each agent in agents.json, or pass defaultAgentId",
    });
  }

  zohoPhoneBridge.saveOrg(orgId, {
    agentMap: map,
    defaultAgentId: defaultAgentId || null,
    registrations,
    zohoUsers: zohoUsers.map(u => ({ zohouser: String(u.zohouser), email: u.email || null, username: u.username || null })),
  });
  sendJson(res, failures.length ? 502 : 200, {
    registered: failures.length === 0,
    integrationActivated: true,
    registrations,
    failures,
    unmatchedAgents,
    unmatchedZohoUsers: unmatchedZohoUsers.map(u => ({ zohouser: u.zohouser, email: u.email, username: u.username })),
  });
}

/** Admin: deregister click-to-dial, revoke the refresh token, delete the org. */
async function handleZohoPbDisconnect(req, res) {
  const { orgId } = await readBody(req).catch(() => ({}));
  const org = orgId && zohoPhoneBridge.getOrg(orgId);
  if (!org) return sendJson(res, 404, { error: `unknown orgId '${orgId}'` });
  const steps = [];
  for (const r of org.registrations || []) {
    const out = await zohoPhoneBridge.unregisterClickToDial({ orgId, zohoUser: r.zohoUser, credentials: pbCredentials() })
      .catch(err => ({ ok: false, body: err.message }));
    steps.push({ unregister: r.agentId, ok: out.ok });
  }
  if (org.refreshToken && org.accountsDomain) {
    const revoke = await fetch(`${org.accountsDomain}/oauth/v2/token/revoke?token=${encodeURIComponent(org.refreshToken)}`, { method: "POST" })
      .catch(err => ({ ok: false, status: err.message }));
    steps.push({ revokeRefreshToken: revoke.ok });
  }
  zohoPhoneBridge.removeOrg(orgId);
  sendJson(res, 200, { disconnected: orgId, steps });
}

/**
 * Zoho calls this when a user clicks a phone number. `tonumber` is the callee.
 * The URI was registered by us and carries an HMAC token for its org and agent;
 * without it no call is placed.
 */
async function handleZohoPbClickToDial(req, res, url) {
  const orgId = url.searchParams.get("orgId");
  const uriAgentId = url.searchParams.get("agentId");
  const token = url.searchParams.get("t");
  if (!auth.verifyClickToDialToken(orgId, uriAgentId, token)) {
    console.warn(`[zoho-pb] click-to-dial refused — bad or missing token (org=${orgId} agent=${uriAgentId})`);
    return sendJson(res, 401, { status: "error", message: "unauthorized" });
  }
  const fields = await readBody(req).catch(() => ({}));
  for (const [k, v] of url.searchParams) if (!(k in fields)) fields[k] = v;
  const rawTo = fields.tonumber || fields.toNumber || fields.to;
  // Only a phone number is ever handed to the softphone.
  const to = dialableNumber(rawTo);
  const org = zohoPhoneBridge.getOrg(orgId);

  // Zoho says who clicked. When that user is mapped to an agent, it wins over
  // the agent baked into the URI.
  const zohoUser = fields.zohouser || fields.zohoUser || null;
  const mappedAgent = org && agentForZohoUser(org.agentMap, zohoUser);
  const agentId = mappedAgent || uriAgentId;
  const agent = getAgent(agentId);
  const session = vobizAccounts.sessionFor(agentId);
  const from = (session && session.callerId) || "";
  const effectiveZohoUser = zohoUser || (org && org.agentMap && org.agentMap[agentId]) || null;
  console.log(`[zoho-pb] click-to-dial — org=${orgId} agent=${agentId} to=${to || JSON.stringify(String(rawTo || "").slice(0, 40))} zohouser=${zohoUser}`);

  const failWith = async (code, status, payload) => {
    if (org) {
      await zohoPhoneBridge.notifyClickToDialError({
        orgId, from, to: to || String(rawTo || "").slice(0, 40), code, credentials: pbCredentials(),
      }).catch(err => console.error("[zoho-pb] clicktodialerror notify failed:", err.message));
    }
    return sendJson(res, status, payload);
  };

  if (!rawTo) return sendJson(res, 400, { status: "error", message: "no 'tonumber' in the request" });
  if (!org) return sendJson(res, 400, { status: "error", message: `unknown or unconnected orgId '${orgId}'` });
  if (!to) return failWith("INVALID_NUMBER", 400, { status: "error", message: "'tonumber' is not a phone number" });
  if (!agent) return failWith("UNKNOWN_AGENT", 400, { status: "error", message: `unknown agent '${agentId}'` });
  const publicBaseUrl = getPublicBaseUrl();
  if (!publicBaseUrl) return failWith("NOT_CONFIGURED", 500, { status: "error", message: "PUBLIC_BASE_URL not set" });

  // The agent must have the softphone open AND be signed in to Vobiz there —
  // that sign-in is the only place this backend learns which Vobiz account
  // and caller ID to use — in the tab that holds the phone line.
  if (!session || !lineTabStream(agentId)) {
    return failWith("AGENT_OFFLINE", 409, {
      status: "error",
      message: `agent '${agentId}' is not signed in to the softphone`,
      hint: "open /agent-phone and sign in to Vobiz there",
    });
  }
  if (!from) return failWith("NO_CALLER_ID", 409, { status: "error", message: "the agent's Vobiz account has no number to use as caller ID" });

  // Agent first: hand the number to the open softphone, which places the
  // INVITE; /answer then dials the customer. A click still waiting from
  // before is closed first: only the newest one can become the call.
  closePendingClick(agentId, null, "a newer click replaced it");
  const callId = `vobiz-browser-${crypto.randomUUID()}`;
  const pending = {
    orgId, callId, agentId, authId: session.authId, zohoUser: effectiveZohoUser, type: "dialed", from, to, createdAtMs: Date.now(),
  };
  pendingBrowserCalls.set(agentId, pending);
  const timer = setTimeout(() => closePendingClick(agentId, callId, "the softphone never placed the call"), pendingClickWindowMs());
  timer.unref();
  pendingClickTimers.set(callId, timer);
  clickRingingSent.set(pending, zohoPhoneBridge.notifyCall({
    orgId, type: "dialed", state: "ringing", callId, from, to, zohoUser: effectiveZohoUser, credentials: pbCredentials(),
  }).catch(err => console.error("[zoho-pb] ringing notify failed:", err.message)));
  pushToLineTab(agentId, { type: "dial", to, callId }, { type: "dial-elsewhere", to });
  return sendJson(res, 200, { status: "success", code: "SUCCESS", callid: callId, dialedBy: "softphone" });
}

/** Drop the agent's waiting click and its timer, without telling Zoho anything. */
function forgetPendingClick(agentId) {
  const pending = pendingBrowserCalls.get(agentId);
  if (!pending) return null;
  pendingBrowserCalls.delete(agentId);
  clearTimeout(pendingClickTimers.get(pending.callId));
  pendingClickTimers.delete(pending.callId);
  return pending;
}

/**
 * A click-to-dial that never became a call — the softphone's call failed, a
 * newer click replaced it, the agent signed out, or nothing happened within
 * the window — is closed in Zoho as unanswered, so its call bar never stays on
 * "ringing" and the attempt is still in the call log. Only the agent's waiting
 * click is touched, and with `callId` only that one: a click already bound to a
 * Vobiz call is closed by that call's own webhooks.
 */
function closePendingClick(agentId, callId, reason) {
  const pending = pendingBrowserCalls.get(agentId);
  if (!pending || (callId && pending.callId !== callId)) return false;
  forgetPendingClick(agentId);
  console.log(`[zoho-pb] ${pending.callId} closed unanswered — ${reason}`);
  Promise.resolve(clickRingingSent.get(pending)).then(() => notifyUnanswered({
    orgId: pending.orgId, type: pending.type, callId: pending.callId,
    from: pending.from, to: pending.to, startedAtMs: pending.createdAtMs, voiceUri: null,
    zohoUser: pending.zohoUser, credentials: pbCredentials(),
  })).catch(err => console.error("[zoho-pb] closing an unanswered click failed:", err.message));
  return true;
}

/**
 * How Zoho is told a call was never answered: `missed` (with its mandatory
 * start_time) when ZOHO_PB_SEND_MISSED_STATE is on and Zoho accepts it,
 * otherwise `ended` with 0 seconds.
 */
async function notifyUnanswered(base) {
  if (ZOHO_PB_SEND_MISSED_STATE) {
    const missed = await zohoPhoneBridge.notifyCall({ ...base, state: "missed" });
    if (missed.ok) return;
    console.warn(`[zoho-pb] Zoho refused 'missed' for ${base.callId} — logging it as ended/0s instead`);
  }
  await zohoPhoneBridge.notifyCall({ ...base, state: "ended", durationSec: 0 });
}

/**
 * The single `ended` (or `missed`) that closes a call in Zoho and doubles as
 * its call log. Idempotent: it untracks first, so the recording webhook and
 * the dial-result timer cannot both send it.
 */
async function finalizeZohoPhoneBridgeCall(callUuid, { recordingId, durationSec } = {}) {
  if (!callUuid) return;
  const tracked = zohoPhoneBridge.untrackCall(callUuid);
  if (!tracked) return;

  const answered = Boolean(tracked.answeredAtMs);
  const startMs = tracked.answeredAtMs || tracked.startedAtMs;
  let duration = 0;
  if (answered) {
    const billed = await fetchVobizBilledDuration(tracked.authId, tracked.bLegUuid || callUuid);
    duration = billed != null ? billed : durationSec != null ? durationSec : Math.round((Date.now() - startMs) / 1000);
  }
  const publicBaseUrl = getPublicBaseUrl();
  const voiceUri = recordingId && publicBaseUrl && tracked.authId
    ? buildSignedRecordingUrl(tracked.authId, tracked.agentId, recordingId, publicBaseUrl)
    : null;
  const base = {
    orgId: tracked.orgId, type: tracked.type, callId: tracked.callId,
    from: tracked.from, to: tracked.to, startedAtMs: startMs, voiceUri,
    zohoUser: tracked.zohoUser, credentials: pbCredentials(),
  };

  if (answered) await zohoPhoneBridge.notifyCall({ ...base, state: "ended", durationSec: duration });
  else await notifyUnanswered(base);
  console.log(`[zoho-pb] finalized ${tracked.callId} — ${answered ? `${duration}s` : "unanswered"}${voiceUri ? " with recording" : ""}`);
}

/** Admin + ZOHO_PB_DEBUG=true: a passthrough confined to phonebridge/v3. */
async function handleZohoPbDebug(req, res) {
  if (process.env.ZOHO_PB_DEBUG !== "true") return sendJson(res, 404, { error: "not found" });
  const { orgId, path: apiPath, method = "GET", form = {} } = await readBody(req).catch(() => ({}));
  const org = orgId && zohoPhoneBridge.getOrg(orgId);
  if (!org) return sendJson(res, 400, { error: `unknown orgId '${orgId}'` });
  const safePath = String(apiPath || "").replace(/^\/+/, "");
  if (!/^[a-z0-9/_-]+$/i.test(safePath) || safePath.includes("..")) {
    return sendJson(res, 400, { error: "path must be a simple phonebridge/v3 sub-path" });
  }
  const verb = String(method).toUpperCase();
  if (!["GET", "POST", "DELETE"].includes(verb)) return sendJson(res, 400, { error: "method must be GET, POST or DELETE" });
  const accessToken = await zohoPhoneBridge.getAccessToken(orgId, pbCredentials());
  const init = { method: verb, headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } };
  if (verb !== "GET") {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  }
  const zohoRes = await fetch(`${org.apiDomain}/phonebridge/v3/${safePath}`, init);
  const text = await zohoRes.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 2000) }; }
  sendJson(res, 200, { status: zohoRes.status, body: parsed });
}

async function handleZohoPbStatus(req, res) {
  let datacentres = null;
  let serverInfoError = null;
  try {
    datacentres = Object.keys(await zohoPhoneBridge.resolveServerInfo());
  } catch (err) {
    serverInfoError = err.message;
  }
  sendJson(res, 200, {
    configured: pbConfigured(),
    redirectUri: ZOHO_PB_REDIRECT_URI || null,
    publicBaseUrl: getPublicBaseUrl(),
    scopes: zohoPhoneBridge.PHONEBRIDGE_SCOPES,
    datacentres,
    serverInfoError,
    agents: Object.keys(loadAgents()),
    // Vobiz accounts agents have signed in with since the last restart — ids
    // and counts only, never a token.
    vobizAccounts: vobizAccounts.listSignedIn(),
    connectedOrgs: zohoPhoneBridge.listOrgs(),
    activeCalls: zohoPhoneBridge.listActiveCalls().map(c => ({ callId: c.callId, type: c.type, agentId: c.agentId, answered: Boolean(c.answeredAtMs) })),
  });
}

// ---------------------------------------------------------------------------
// Agent and admin sessions
// ---------------------------------------------------------------------------

async function handleAgentSession(req, res) {
  const { agentId, key } = await readBody(req).catch(() => ({}));
  if (!getAgent(agentId) || !auth.verifyAgentKey(agentId, key)) {
    return sendJson(res, 401, { error: "unknown agent or wrong key" });
  }
  sendJson(res, 200, { ok: true, agentId }, { "Set-Cookie": auth.agentCookie(req, agentId) });
}

/**
 * Who this softphone is signed in as. Never carries a SIP password or an Auth
 * Token: the password is handed out once, in the /agent/vobiz-session reply.
 */
function handleAgentMe(req, res, requestedId) {
  const agentId = auth.agentFromRequest(req);
  if (!agentId) return sendJson(res, 401, { error: "not signed in" });
  if (requestedId && requestedId !== "me" && requestedId !== agentId) return sendJson(res, 403, { error: "forbidden" });
  const agent = getAgent(agentId);
  if (!agent) return sendJson(res, 401, { error: "not signed in" });
  const session = vobizAccounts.sessionFor(agentId);
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, 200, {
    agentId,
    displayName: agent.displayName || agentId,
    vobiz: session ? { mode: session.mode, authId: session.authId, callerId: session.callerId } : null,
    // How the softphone offers the "Vobiz account" sign-in: on the account an
    // admin connected for this agent (no fields to fill), or — only when the
    // backend allows it — with a typed Auth ID and Auth Token.
    vobizSignIn: { connectedAccount: connectedAccountFor(agentId), agentTokenAllowed: agentTokenSignInAllowed() },
  });
}

/**
 * The connected Vobiz account an agent signs in on: the one assigned to them
 * in agents.json (`vobizAccount`), or the only connected account. Never one
 * the browser asks for — with several customers' accounts connected, an
 * agent must not be able to pick another customer's.
 */
function connectedAccountFor(agentId) {
  const ids = vobizAccounts.connectedAccountIds();
  const agent = getAgent(agentId);
  const assigned = agent && agent.vobizAccount ? String(agent.vobizAccount).trim() : null;
  if (assigned) return ids.includes(assigned) ? assigned : null;
  return ids.length === 1 ? ids[0] : null;
}

/** The agent's cookie names the agent; the body names the Vobiz account. */
function agentOr401(req, res) {
  const agentId = auth.agentFromRequest(req);
  if (!agentId || !getAgent(agentId)) {
    sendJson(res, 401, { error: "not signed in" });
    return null;
  }
  return agentId;
}

function vobizErrorStatus(err) {
  if (err instanceof vobizAccounts.VobizAuthError) return 401;
  const s = Number(err && err.status);
  if (s === 409) return 409;
  return s >= 400 && s < 500 ? 400 : 502;
}

/**
 * The tab that just signed in now holds the agent's phone line. Vobiz keeps
 * one registration per endpoint, so every other open tab of the agent is told
 * it was signed in elsewhere and stops its phone.
 */
function takeLine(agentId, tabId) {
  if (tabId) lineTabs.set(agentId, tabId);
  else lineTabs.delete(agentId);
  tellOtherTabs(agentId, tabId);
}

/**
 * Softphone sign-in to Vobiz, on the account an admin connected for this
 * agent: no Auth Token from the browser. Finds or creates this integration's
 * application in that account and the agent's endpoint, and returns the SIP
 * login with a fresh password — a new one on every sign-in, handed only to
 * the tab that asked.
 *
 * A request that carries an Auth Token is the old sign-in, where the agent
 * typed the account's master key. It is refused unless ALLOW_AGENT_AUTH_TOKEN
 * is on; then it works as before and the token stays in server memory only.
 */
async function handleVobizSession(req, res) {
  const agentId = agentOr401(req, res);
  if (!agentId) return;
  const { authId, authToken, callerId, tabId } = await readBody(req).catch(() => ({}));
  res.setHeader("Cache-Control", "no-store");
  try {
    let out;
    if (authToken) {
      if (!agentTokenSignInAllowed()) {
        return sendJson(res, 403, {
          error: "Agents do not sign in with the account's Auth Token here. Ask your admin to connect the Vobiz account; then sign in without it.",
        });
      }
      out = await vobizAccounts.signIn({ agentId, authId, authToken, callerId, publicBaseUrl: getPublicBaseUrl() });
    } else {
      const account = connectedAccountFor(agentId);
      if (!account) {
        return sendJson(res, 409, { error: "No Vobiz account is connected for you yet. Ask your admin to connect it." });
      }
      out = await vobizAccounts.signInConnected({ agentId, authId: account, callerId, publicBaseUrl: getPublicBaseUrl() });
    }
    takeLine(agentId, tabIdOf(tabId));
    sendJson(res, 200, out);
  } catch (err) {
    console.warn(`[vobiz] sign-in for ${agentId} failed: ${err.message}`);
    sendJson(res, vobizErrorStatus(err), { error: err.message });
  }
}

/**
 * SIP-direct sign-in: an endpoint the customer already has. Only the username
 * and caller ID come here; the browser keeps the SIP password to itself.
 */
async function handleSipSession(req, res) {
  const agentId = agentOr401(req, res);
  if (!agentId) return;
  const { sipUser, callerId, tabId } = await readBody(req).catch(() => ({}));
  res.setHeader("Cache-Control", "no-store");
  try {
    const out = vobizAccounts.signInSipDirect({ agentId, sipUser, callerId });
    takeLine(agentId, tabIdOf(tabId));
    sendJson(res, 200, out);
  } catch (err) {
    sendJson(res, vobizErrorStatus(err), { error: err.message });
  }
}

/** Sign the agent out of Vobiz; a click still waiting for them is closed in Zoho. */
function signOutAgent(agentId) {
  vobizAccounts.signOut(agentId);
  lineTabs.delete(agentId);
  closePendingClick(agentId, null, "the agent signed out");
}

async function handleVobizSignOut(req, res) {
  const agentId = agentOr401(req, res);
  if (!agentId) return;
  signOutAgent(agentId);
  sendJson(res, 200, { ok: true });
}

/**
 * The softphone could not place a click-to-dial call: it was not registered,
 * the call would not start, or JsSIP reported `failed` before Vobiz ever ran
 * /answer. Closes that click in Zoho as unanswered. An agent can only close
 * their own waiting click; anything already bound to a Vobiz call is logged
 * from that call's webhooks instead, so a report for it changes nothing.
 */
async function handleCallFailed(req, res) {
  const agentId = agentOr401(req, res);
  if (!agentId) return;
  const { callId, cause } = await readBody(req).catch(() => ({}));
  const why = String(cause || "unknown").replace(/[^\w .,:'()/-]/g, "").slice(0, 60) || "unknown";
  const closed = typeof callId === "string" && callId.length > 0 &&
    closePendingClick(agentId, callId, `the softphone's call failed (${why})`);
  sendJson(res, closed ? 200 : 404, { closed: Boolean(closed) });
}

async function handleCallerId(req, res) {
  const agentId = agentOr401(req, res);
  if (!agentId) return;
  const { callerId } = await readBody(req).catch(() => ({}));
  const set = vobizAccounts.setCallerId(agentId, callerId);
  if (!set) return sendJson(res, 400, { error: "that number is not on your Vobiz account" });
  sendJson(res, 200, { callerId: set });
}

/**
 * "Enable inbound calls": attach the chosen DID to this integration's
 * application. Explicit only — it moves the number off whatever application
 * answered it before.
 */
async function handleEnableInbound(req, res) {
  const agentId = agentOr401(req, res);
  if (!agentId) return;
  const { number } = await readBody(req).catch(() => ({}));
  try {
    sendJson(res, 200, { ok: true, ...(await vobizAccounts.attachNumber(agentId, number)) });
  } catch (err) {
    sendJson(res, vobizErrorStatus(err), { error: err.message });
  }
}

/**
 * The softphone accepted an inbound call: the call log goes to this agent.
 * Fallback for when the Dial callback does not name the answering leg. An
 * agent can only claim a call that rang them.
 */
async function handleInboundAnswered(req, res) {
  const agentId = agentOr401(req, res);
  if (!agentId) return;
  const { callUuid } = await readBody(req).catch(() => ({}));
  const ok = attributeInboundTo(String(callUuid || ""), agentId, "softphone");
  sendJson(res, ok ? 200 : 404, { logged: ok });
}

/** The agent's event stream. ?tab= names the softphone tab it belongs to. */
function handleCallEvents(req, res, requestedId, url) {
  const agentId = auth.agentFromRequest(req);
  if (!agentId || (requestedId && requestedId !== agentId)) return sendJson(res, 401, { error: "not signed in" });
  res.vobizTab = tabIdOf(url && url.searchParams.get("tab"));
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": connected\n\n");
  if (!callEventListeners.has(agentId)) callEventListeners.set(agentId, new Set());
  callEventListeners.get(agentId).add(res);
  req.on("close", () => {
    const listeners = callEventListeners.get(agentId);
    if (!listeners) return;
    listeners.delete(res);
    if (listeners.size === 0) callEventListeners.delete(agentId);
  });
}

function handleAdminLoginForm(req, res) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin sign-in</title>
<style>:root{color-scheme:light dark}body{font:15px/1.6 system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px 16px}
input,button{font-size:15px;padding:10px;width:100%;box-sizing:border-box;margin-top:8px}</style>
<h1>Admin sign-in</h1>
<form method="POST" action="session"><input name="token" type="password" placeholder="ADMIN_TOKEN" autofocus><button>Sign in</button></form>`);
}

async function handleAdminSession(req, res) {
  const { token } = await readBody(req).catch(() => ({}));
  if (!auth.verifyAdminToken(token)) return sendJson(res, 401, { error: "wrong token" });
  sendJson(res, 200, { ok: true, next: `${getPublicBaseUrl() || ""}/zoho/phonebridge/connect` }, { "Set-Cookie": auth.adminCookie(req) });
}

/** Admin: the form for connecting a Vobiz account, for a browser with the admin cookie. */
function handleVobizAccountForm(req, res) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect a Vobiz account</title>
<style>:root{color-scheme:light dark}body{font:15px/1.6 system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 16px}
input,button{font-size:15px;padding:10px;width:100%;box-sizing:border-box;margin-top:8px}</style>
<h1>Connect a Vobiz account</h1>
<p>The Auth ID and Auth Token from Vobiz Console &rarr; API credentials. The token is checked with Vobiz and
stored encrypted on this backend. Agents then sign in from the softphone without it.</p>
<form method="POST" action="vobiz-account" autocomplete="off">
<input name="authId" placeholder="Auth ID" spellcheck="false" autofocus>
<input name="authToken" type="password" placeholder="Auth Token">
<button>Connect</button></form>`);
}

/** Admin: connect a Vobiz account once. Ids and counts in the reply, never the token. */
async function handleVobizAccountConnect(req, res) {
  const { authId, authToken } = await readBody(req).catch(() => ({}));
  res.setHeader("Cache-Control", "no-store");
  try {
    const out = await vobizAccounts.connectAccount({ authId, authToken, publicBaseUrl: getPublicBaseUrl() });
    sendJson(res, 200, { connected: true, ...out, next: "Agents now sign in to Vobiz from the softphone without the Auth Token." });
  } catch (err) {
    console.warn(`[vobiz] connecting a Vobiz account failed: ${err.message}`);
    sendJson(res, vobizErrorStatus(err), { error: err.message });
  }
}

/** Admin: forget a connected account and sign its agents out. */
async function handleVobizAccountDisconnect(req, res) {
  const { authId } = await readBody(req).catch(() => ({}));
  const id = String(authId || "").trim();
  if (!id || !vobizAccounts.disconnectAccount(id)) return sendJson(res, 404, { error: `no connected Vobiz account '${id}'` });
  sendJson(res, 200, { disconnected: id });
}

function handleAgentLinks(req, res) {
  const base = getPublicBaseUrl() || "";
  const links = {};
  for (const agentId of Object.keys(loadAgents())) {
    links[agentId] = `${base}/agent-phone#agent=${encodeURIComponent(agentId)}&key=${auth.agentKey(agentId)}`;
  }
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, 200, { links, note: "Each link signs that agent in. Treat it like a password." });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const wrap = fn => (req, res, ...args) =>
  Promise.resolve(fn(req, res, ...args)).catch(err => failRequest(req, res, err));

function requireAdmin(handler) {
  return (req, res, ...args) => {
    if (!auth.adminConfigured()) return sendJson(res, 503, { error: "ADMIN_TOKEN is not set on this backend" });
    if (!auth.isAdmin(req)) return sendJson(res, 401, { error: "admin authentication required" });
    return handler(req, res, ...args);
  };
}

const STATIC_FILES = {
  "/agent-phone": ["agent-phone.html", "text/html; charset=utf-8"],
  "/agent-phone.html": ["agent-phone.html", "text/html; charset=utf-8"],
  "/jssip.min.js": ["jssip.min.js", "application/javascript"],
};

const routes = {
  "GET /health": (req, res) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok"); },

  // Vobiz
  "POST /answer": wrap(handleAnswer),
  "GET /answer": wrap(handleAnswer),
  "POST /hangup": wrap(handleHangup),
  "POST /inbound-answer": wrap(handleInboundAnswer),
  "GET /inbound-answer": wrap(handleInboundAnswer),
  "POST /dial-event": wrap(handleDialEvent),
  "POST /dial-result": wrap(handleDialResult),
  "POST /recording-ready": wrap(handleRecordingReady),

  // Zoho
  "POST /zoho/phonebridge/clicktodial": wrap(handleZohoPbClickToDial),
  "GET /zoho/phonebridge/clicktodial": wrap(handleZohoPbClickToDial),
  "GET /zoho/phonebridge/callback": wrap(handleZohoPbCallback),
  // The path registered with Zoho's partner application, served unchanged.
  "GET /oauth/zoho/callback": wrap(handleZohoPbCallback),
  "GET /zoho/phonebridge/recording": wrap(handleZohoPbRecording),

  // Admin
  "GET /admin/login": handleAdminLoginForm,
  "POST /admin/session": wrap(handleAdminSession),
  "GET /admin/agent-links": requireAdmin(handleAgentLinks),
  "GET /admin/vobiz-account": requireAdmin(handleVobizAccountForm),
  "POST /admin/vobiz-account": requireAdmin(wrap(handleVobizAccountConnect)),
  "POST /admin/vobiz-account/disconnect": requireAdmin(wrap(handleVobizAccountDisconnect)),
  "GET /zoho/phonebridge/connect": requireAdmin(wrap(handleZohoPbConnect)),
  "GET /zoho/phonebridge/complete": requireAdmin(handleZohoPbCompleteForm),
  "POST /zoho/phonebridge/complete": requireAdmin(wrap(handleZohoPbComplete)),
  "POST /zoho/phonebridge/register": requireAdmin(wrap(handleZohoPbRegister)),
  "POST /zoho/phonebridge/disconnect": requireAdmin(wrap(handleZohoPbDisconnect)),
  "GET /zoho/phonebridge/status": requireAdmin(wrap(handleZohoPbStatus)),
  "POST /zoho/phonebridge/debug": requireAdmin(wrap(handleZohoPbDebug)),

  // Agent
  "POST /agent-session": wrap(handleAgentSession),
  "POST /agent-logout": (req, res) => {
    const agentId = auth.agentFromRequest(req);
    if (agentId) signOutAgent(agentId);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": auth.clearAgentCookie() });
  },
  "POST /agent/vobiz-session": wrap(handleVobizSession),
  "POST /agent/sip-session": wrap(handleSipSession),
  "POST /agent/vobiz-logout": wrap(handleVobizSignOut),
  "POST /agent/caller-id": wrap(handleCallerId),
  "POST /agent/enable-inbound": wrap(handleEnableInbound),
  "POST /agent/inbound-answered": wrap(handleInboundAnswered),
  "POST /agent/call-failed": wrap(handleCallFailed),
  "GET /call-events": (req, res, url) => handleCallEvents(req, res, null, url),
};

function dispatch(req, res) {
  auth.applyCors(req, res);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return sendJson(res, 400, { error: "bad request" });
  }
  const p = url.pathname;

  const route = routes[`${req.method} ${p}`];
  if (route) return route(req, res, url);

  if (req.method === "GET" && (p.startsWith("/agent/") || p.startsWith("/call-events/"))) {
    const prefix = p.startsWith("/agent/") ? "/agent/" : "/call-events/";
    const id = decodeSegment(p.slice(prefix.length));
    if (id === null) return sendJson(res, 400, { error: "bad request" });
    return prefix === "/agent/" ? handleAgentMe(req, res, id) : handleCallEvents(req, res, id, url);
  }

  // Static files come from a fixed whitelist — no path from the request ever
  // reaches the filesystem.
  const file = req.method === "GET" && STATIC_FILES[p];
  if (file) {
    return fs.readFile(path.join(__dirname, "public", file[0]), (err, buf) => {
      if (err) return sendJson(res, 404, { error: "not found" });
      const headers = { "Content-Type": file[1], "Cache-Control": "no-store" };
      if (file[0] === "agent-phone.html") headers["Content-Security-Policy"] = softphoneCsp(buf);
      res.writeHead(200, headers);
      res.end(buf);
    });
  }

  sendJson(res, 404, { error: "not found" });
}

/**
 * Every request runs inside this guard. A handler that throws, or rejects,
 * gets a 500 for that one request; the process — every other agent's session,
 * every call in progress — carries on.
 */
const server = http.createServer((req, res) => {
  try {
    const out = dispatch(req, res);
    if (out && typeof out.catch === "function") out.catch(err => failRequest(req, res, err));
  } catch (err) {
    failRequest(req, res, err);
  }
});

// Only bind the port when run directly; the test suite requires the module.
if (require.main === module) startServer();

function startServer() {
  // Fail at boot, not on the first OAuth callback.
  parseKey(process.env.TOKEN_ENCRYPTION_KEY);
  if (!process.env.ADMIN_TOKEN) console.warn("[backend] ADMIN_TOKEN is not set — admin routes are disabled");
  if (!pbConfigured()) console.warn("[backend] ZOHO_PB_CLIENT_ID / _SECRET / _REDIRECT_URI not all set — Zoho connect is disabled");
  if (!getPublicBaseUrl()) console.warn("[backend] PUBLIC_BASE_URL is not set — Vobiz and Zoho cannot reach this backend");
  if (!signatureRequired()) {
    console.warn("[backend] REQUIRE_VOBIZ_SIGNATURE=false — Vobiz webhooks are accepted WITHOUT a valid signature, so anyone who can reach this backend can send it fake call events. Remove it once your logs show \"signature ok\".");
  }
  if (agentTokenSignInAllowed()) {
    console.warn("[backend] ALLOW_AGENT_AUTH_TOKEN=true — agents may type the account's Auth Token into the softphone. Connect the account at /admin/vobiz-account instead, then remove this.");
  }
  const connected = vobizAccounts.connectedAccountIds();
  console.log(`[backend] ${connected.length} Vobiz account(s) connected${connected.length ? "" : " — an admin connects one at /admin/vobiz-account"}`);
  // A promise someone forgot to catch is logged, not fatal: the process holds
  // every agent's session and every call in progress.
  process.on("unhandledRejection", err => console.error("[backend] unhandled rejection (still running):", err));
  server.listen(Number(PORT) || 8092, () => {
    console.log(`[backend] listening on http://localhost:${Number(PORT) || 8092} — public URL ${getPublicBaseUrl() || "(unset)"}`);
  });
}

// `routes` is exported so the test suite can prove the request guard holds.
module.exports = { server, startServer, finalizeZohoPhoneBridgeCall, auth, verifyVobizSignature, routes };
