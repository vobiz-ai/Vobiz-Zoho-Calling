const http = require("http");
const fs = require("fs");
const crypto = require("crypto");

try {
  process.loadEnvFile(__dirname + "/.env");
} catch {
  // No local .env file — expected when deployed, where real env vars are
  // set directly on the host instead of loaded from a committed file.
}

const TUNNEL_URL_FILE = __dirname + "/tunnel-url.txt";
function getPublicBaseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  try {
    const url = fs.readFileSync(TUNNEL_URL_FILE, "utf8").trim();
    return url || null;
  } catch {
    return null;
  }
}

const zohoPhoneBridge = require("./zoho-phonebridge");

const {
  VOBIZ_FROM_NUMBER,
  // Account-level credentials. Used as the fallback when no agent has logged
  // in through a softphone — see handleZohoPbClickToDial.
  VOBIZ_AUTH_ID,
  VOBIZ_AUTH_TOKEN,
  PORT,
  ZOHO_TEST_CLIENT_ID,
  ZOHO_TEST_CLIENT_SECRET,
  ZOHO_REDIRECT_URI,
  ZOHO_ACCOUNTS_DOMAIN,
  ZOHO_API_DOMAIN,
  // PhoneBridge uses its own credentials, issued by Zoho's partner team when
  // VoBiz was registered — separate from the ZOHO_TEST_* pair above, which is
  // a self-registered api-console client used by the older Deluge experiment.
  // Falls back to the test pair so this can be exercised locally before the
  // partner credentials are wired in.
  ZOHO_PB_CLIENT_ID,
  ZOHO_PB_CLIENT_SECRET,
  ZOHO_PB_REDIRECT_URI,
  HUBSPOT_APP_ID,
  HUBSPOT_CLIENT_ID,
  HUBSPOT_CLIENT_SECRET,
  HUBSPOT_REDIRECT_URI,
  SALESFORCE_CLIENT_ID,
  SALESFORCE_CLIENT_SECRET,
  SALESFORCE_REDIRECT_URI,
  SALESFORCE_LOGIN_URL,
  VAPI_SIP_URI,
} = process.env;

// PhoneBridge credentials, with a fallback to the older test client so the
// whole flow can be walked through locally before the partner credentials
// are in place. The redirect URI must match one registered with Zoho exactly.
const PB_CLIENT_ID = ZOHO_PB_CLIENT_ID || ZOHO_TEST_CLIENT_ID;
const PB_CLIENT_SECRET = ZOHO_PB_CLIENT_SECRET || ZOHO_TEST_CLIENT_SECRET;
const PB_REDIRECT_URI = ZOHO_PB_REDIRECT_URI || ZOHO_REDIRECT_URI;
const pbCredentials = () => ({ clientId: PB_CLIENT_ID, clientSecret: PB_CLIENT_SECRET });

// Signing key for the public, time-limited recording URLs handed to Zoho as
// `voiceuri`. Zoho fetches that URL with no VoBiz credentials of its own, so
// it cannot use /recording-audio (which needs a logged-in session). Derived
// from an explicit secret when one is set, otherwise generated per boot —
// fine for a demo, but it means links stop working across restarts.
const RECORDING_URL_SECRET =
  process.env.RECORDING_URL_SECRET || crypto.randomBytes(32).toString("hex");

// How long to wait after a call ends for its recording webhook before giving
// up and logging the call to Zoho without audio. Recordings typically land in
// 30-60s; this is the backstop, not the happy path.
const ZOHO_PB_RECORDING_GRACE_MS = Number(process.env.ZOHO_PB_RECORDING_GRACE_MS || 90_000);

// Zoho's live PhoneBridge API rejects every terminal callnotify state except
// `ended` — `missed`, `busy`, `rejected`, `noanswer` and `notavailable` all
// come back 400, despite being documented (ISSUES.md #4). Unanswered calls are
// therefore logged as `ended` with duration 0. Set this to true to send the
// accurate state instead, once Zoho accepts it.
const ZOHO_PB_SEND_MISSED_STATE = process.env.ZOHO_PB_SEND_MISSED_STATE === "true";

const ZOHO_TOKENS_FILE = __dirname + "/zoho-tokens.json";
const HUBSPOT_TOKENS_FILE = __dirname + "/hubspot-tokens.json";
const SALESFORCE_TOKENS_FILE = __dirname + "/salesforce-tokens.json";
const HUBSPOT_SCOPES = "oauth crm.objects.contacts.read crm.objects.contacts.write";

const AGENTS_FILE = __dirname + "/agents.json";
function getAgent(agentId) {
  const agents = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
  return agents[agentId] || null;
}

// Which platform (zoho, freshdesk, salesforce, ...) started each call, keyed
// by VoBiz's request_uuid/CallUUID. Set at /start-call, read once at
// /recording-ready so the sync-back step only ever writes to the ONE CRM
// that actually placed the call — never every CRM that happens to know
// this phone number.
const callPlatform = new Map();

// Real-time call events, replacing the every-3-seconds polling every
// frontend was doing. Keyed by agentId rather than callUuid: Zoho's Deluge
// button places the call entirely on Zoho's own servers, so the browser
// tab that actually needs to know about it (agent-phone.html) never learns
// a callUuid on its own — it just opens one connection for "my agentId"
// when the tab loads, and hears about every call that agent places or
// finishes, no matter which platform's button started it.
const callEventListeners = new Map(); // agentId -> Set<res>

// Set BROWSER_FIRST_DIAL=false to go back to customer-first dialling, which is
// what this integration did before the agent softphone existed.
const BROWSER_FIRST_DIAL = process.env.BROWSER_FIRST_DIAL !== "false";

// Calls handed to a softphone, keyed by agent, waiting for VoBiz to tell us the
// CallUUID it assigned. Zoho needs one stable callId for the whole call, so the
// id is minted here and re-keyed onto the real UUID as soon as /answer fires.
const pendingBrowserCalls = new Map();

function hasAgentListener(agentId) {
  const listeners = callEventListeners.get(agentId);
  return Boolean(listeners && listeners.size);
}

function pushAgentEvent(agentId, event) {
  const listeners = callEventListeners.get(agentId);
  if (!listeners) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of listeners) res.write(payload);
}

// Confirms a callback genuinely came from VoBiz — not just anyone who found
// this tunnel's address — before trusting it. VoBiz signs with the calling
// account's own auth_token, so this can only be checked once we know which
// agent/account this call belongs to (passed as ?agentId= on every callback
// URL we hand VoBiz, same way agentId already was for /answer).
function verifyVobizSignature(req, url, authToken) {
  const signature = req.headers["x-vobiz-signature-v3"];
  const nonce = req.headers["x-vobiz-signature-v3-nonce"];
  if (!signature || !nonce || !authToken) {
    console.warn(`[backend] signature check: missing ${!signature ? "signature" : !nonce ? "nonce" : "authToken"} on ${url.pathname}`);
    return false;
  }
  const base = getPublicBaseUrl();
  // VoBiz signs the answer_url it was originally handed. Our callback URLs
  // carry query params (agentId, to), and it isn't documented whether those
  // are part of the signed string — so accept either form. Both still require
  // a valid HMAC from a holder of the account's auth token, so this widens
  // what counts as the signed URL, not who is allowed to sign it.
  const candidates = [
    `${base}${url.pathname}`,
    `${base}${url.pathname}${url.search}`,
  ];
  const sigBuf = Buffer.from(signature);
  for (const candidate of candidates) {
    const expected = crypto
      .createHmac("sha256", authToken)
      .update(`${candidate}.${nonce}`)
      .digest("base64");
    try {
      if (crypto.timingSafeEqual(sigBuf, Buffer.from(expected))) return true;
    } catch {
      // length mismatch — not this candidate, try the next
    }
  }
  // Dump enough to actually fix this rather than guess again. The usual
  // culprit is `base` not matching the URL VoBiz was originally handed, so
  // print what we signed alongside the Host header VoBiz actually reached us
  // on — if those two disagree, that's the bug, not the HMAC.
  console.warn(
    `[backend] signature check FAILED on ${url.pathname}\n` +
    `  candidates signed : ${candidates.join(" | ")}\n` +
    `  request Host      : ${req.headers.host}\n` +
    `  x-forwarded-proto : ${req.headers["x-forwarded-proto"] || "(none)"}\n` +
    `  nonce             : ${nonce}\n` +
    `  signature (theirs): ${signature}\n` +
    `  If "candidates signed" doesn't match how VoBiz addressed us, PUBLIC_BASE_URL is wrong.`,
  );
  return false;
}

// Real per-user login, replacing the single shared VOBIZ_AUTH_ID/TOKEN/
// FROM_NUMBER this backend used to run every call under. Keyed by agentId —
// set once via /login (from whichever browser tab/widget is that agent's
// persistent UI: the HubSpot widget, the Freshdesk sidebar, or Zoho's
// separate agent-phone.html tab), then reused by every /start-call that
// agentId makes afterward, including ones triggered server-side (Zoho's
// Deluge script never sees these credentials directly — it only ever sends
// {to, agentId}, same as before).
const agentSessions = new Map();

function vobizAuthHeaders(authId, authToken) {
  return { "X-Auth-ID": authId, "X-Auth-Token": authToken };
}

// Test-only flow: a small self-contained back-and-forth using Vobiz's own
// Speak + Gather, so a call has real multi-turn duration and content without
// needing a human SIP agent or an external AI platform. Recording is already
// running from the <Record> issued at answer time.
function vobizXmlTestConversation(publicBaseUrl) {
  const gatherAction = `${publicBaseUrl}/gather-response?turn=1`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record recordSession="true" redirect="false" playBeep="false" fileFormat="mp3"
    callbackUrl="${publicBaseUrl}/recording-ready" callbackMethod="POST"/>
  <Gather action="${gatherAction}" method="POST" inputType="speech"
    executionTimeout="12" speechTimeout="3" redirect="true">
    <Speak>Hi, this is the VoBiz test line. Say something and I will read it back to you.</Speak>
  </Gather>
  <Speak>I did not hear anything. Ending the test call now. Goodbye.</Speak>
  <Hangup/>
</Response>`;
}

// Bridges the answered call to a Vapi assistant over SIP instead of the
// scripted test conversation. The Vapi phone number was created with
// provider "vapi" and an explicit sipUri, tied to an existing assistantId —
// dialing that URI is what makes Vapi's assistant answer, real-time,
// bidirectional audio, no auth/registration needed on Vapi's side.
//
// callerId must match whichever VoBiz number actually placed this specific
// call — Vapi's trunk credential silently refuses a caller ID it doesn't
// recognize (this is the ORIGINATOR_CANCEL gotcha from the first attempts
// at this). Now that every call can come from a different logged-in
// account's number, this is read from VoBiz's own answer_url callback
// (its "From" field) rather than one fixed env var.
function vobizXmlDialVapi(publicBaseUrl, callerId, agentId) {
  const agentQs = `agentId=${encodeURIComponent(agentId)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record recordSession="true" redirect="false" playBeep="false" fileFormat="mp3"
    callbackUrl="${publicBaseUrl}/recording-ready?${agentQs}" callbackMethod="POST"
    transcriptionType="auto" transcriptionUrl="${publicBaseUrl}/transcription-ready?${agentQs}"/>
  <Dial timeout="30" redirect="false" method="POST"
    action="${publicBaseUrl}/dial-result?${agentQs}" callerId="${escapeXml(callerId)}">
    <User>${escapeXml(VAPI_SIP_URI)}</User>
  </Dial>
  <Speak>The AI agent could not be reached. Goodbye.</Speak>
  <Hangup/>
</Response>`;
}

// Human-to-human bridge: dials the agent's own registered SIP identity
// (the same registration their browser tab holds open for inbound calls)
// instead of the Vapi assistant. The customer ends up talking directly to
// the human agent who placed the call — no AI in the loop. VoBiz's own
// newRTCSession handler in app.js already auto-answers this leg, since it
// was originally written expecting exactly this "agent leg of an
// outbound-originated call" case.
// Fires once the customer has answered the call we placed to them. Bridges
// them to the human agent's registered WebRTC browser via <Dial><User>,
// which is the only path that actually resolves against VoBiz's registrar
// (REST-dialing the same SIP URI returns "Endpoint Not Registered").
/**
 * The agent's browser dialled out itself, so it is already the A leg and the
 * customer is the one who still needs to be reached.
 *
 * This is the direction that works. Routing *into* a registered WebRTC endpoint
 * with <Dial><User> is broken platform-side — VoBiz builds a gateway URI it
 * cannot parse and drops its own INVITE ("tr_eval_uri(): invalid uri",
 * "blocking gw"), which is what vobizXmlDialAgent below has been living with.
 * Dialling *out* of a registered endpoint has no such problem, and it is also
 * what Zoho's PhoneBridge specification asks for: agent first, customer second
 * (ISSUES.md #3).
 */
function vobizXmlDialCustomer(to, callerId, agentId, publicBaseUrl) {
  const agentQs = `agentId=${encodeURIComponent(agentId)}`;
  const callerIdAttr = callerId ? ` callerId="${escapeXml(callerId)}"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record recordSession="true" redirect="false" playBeep="false" fileFormat="mp3"
    callbackUrl="${publicBaseUrl}/recording-ready?${agentQs}" callbackMethod="POST"/>
  <Dial${callerIdAttr} timeout="30" timeLimit="14400" redirect="false" method="POST"
    action="${publicBaseUrl}/dial-result?${agentQs}">
    <Number>${escapeXml(String(to).replace(/^\+/, ""))}</Number>
  </Dial>
  <Hangup/>
</Response>`;
}

function vobizXmlDialAgent(agent, agentId, publicBaseUrl, callerId) {
  const agentQs = `agentId=${encodeURIComponent(agentId)}`;
  // callerId is REQUIRED here, not cosmetic. Vobiz's docs: "If you omit
  // callerId, Vobiz derives it from the existing A-leg. B-leg creation may
  // fail if that number is not authorized for outbound calling." When it
  // fails this way the B-leg is never created at all — no dial-leg CDR, the
  // call just runs ~3s and falls through to the <Speak> below, which sounds
  // to the customer exactly like the agent declining. Same root cause as the
  // earlier Vapi bridge failures (ORIGINATOR_CANCEL, ~3s, before any ring).
  const callerIdAttr = callerId ? ` callerId="${escapeXml(callerId)}"` : "";

  // Ring the browser AND, when the agent has one configured, their real phone
  // — simultaneously. Vobiz dials sibling children concurrently and bridges
  // whichever answers first, cancelling the loser with code 9000 (Lost Race).
  //
  // This exists because the browser's SIP registration has proved unreliable:
  // the registrar returns a successful REGISTER, but `sip_registered` stays
  // "false" and <Dial><User> is refused with 2020 Endpoint Not Registered.
  // Rather than depend on that, the browser becomes best-effort — if its
  // registration is live the agent talks in the browser as designed, and if it
  // is not, their phone rings instead and the call still connects.
  //
  // Set `phoneNumber` (E.164) on an agent in agents.json to enable the
  // fallback. With no phoneNumber the behaviour is exactly as before.
  const destinations = [`    <User>sip:${escapeXml(agent.sipUser)}</User>`];
  if (agent.phoneNumber) {
    destinations.push(`    <Number>${escapeXml(agent.phoneNumber)}</Number>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record recordSession="true" redirect="false" playBeep="false" fileFormat="mp3"
    callbackUrl="${publicBaseUrl}/recording-ready?${agentQs}" callbackMethod="POST"/>
  <Dial${callerIdAttr} timeout="30" redirect="false" method="POST"
    action="${publicBaseUrl}/dial-result?${agentQs}">
${destinations.join("\n")}
  </Dial>
  <Speak>The agent could not be reached. Goodbye.</Speak>
  <Hangup/>
</Response>`;
}

// Real inbound: a customer calls the VoBiz number directly (not a callback
// on a call we placed). Rings the agent's registered SIP identity — same
// registration the panel already holds open for the outbound bridge-back.
// If nobody answers within `timeout` (laptop closed, tab not open, agent
// away — VoBiz's registrar just has nothing to ring), execution falls
// through to the voicemail verses below. This fallback is plain XML in the
// SAME response VoBiz already fetched, so it still runs even though the
// backend can't be reached a second time — it doesn't depend on the
// backend or the tunnel being up at that later moment.
/**
 * Normalise whatever VoBiz hands us as the dialled number into E.164.
 * Inbound `To` arrives in several shapes — "0XXXXXXXXXX", "91XXXXXXXXXX",
 * "+91XXXXXXXXXX" — and only the last is usable as a callerId.
 */
function toE164(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (v.startsWith("+")) return v;
  if (v.startsWith("0") && v.length === 11) return `+91${v.slice(1)}`;
  return `+${v.replace(/\D/g, "")}`;
}

function vobizXmlInboundToAgent(agent, agentId, publicBaseUrl, dialedNumber) {
  const agentQs = `agentId=${encodeURIComponent(agentId)}`;
  // callerId is REQUIRED, exactly as it is on the outbound bridge above — and
  // for the same reason. Without it VoBiz derives the B-leg's caller ID from
  // the A-leg, which on an inbound PSTN call is the *caller's* number. That
  // number is not one this account owns, B-leg creation is refused, and the
  // browser is never rung: no INVITE reaches the registrar at all, the <Dial>
  // simply times out, and the caller drops through to the voicemail below.
  //
  // Verified against a working inbound call on the same account, which used
  // `<Dial callerId="+91XXXXXXXXXX">` — the DID that was dialled.
  const callerIdAttr = dialedNumber ? ` callerId="${escapeXml(toE164(dialedNumber))}"` : "";
  // Same browser-plus-phone fallback as the outbound path — see
  // vobizXmlDialAgent for why the browser cannot be relied on alone.
  const destinations = [`    <User>sip:${escapeXml(agent.sipUser)}</User>`];
  if (agent.phoneNumber) {
    destinations.push(`    <Number>${escapeXml(agent.phoneNumber)}</Number>`);
  }
  // Deliberately minimal, and matched attribute-for-attribute against a call
  // that is known to reach a browser on this account:
  //
  //   <Dial callerId="+91XXXXXXXXXX"><User>sip:user@registrar.vobiz.ai</User></Dial>
  //
  // Everything this used to carry is gone for a reason:
  //   - `redirect="false"` with no `action` is meaningless — redirect only says
  //     whether XML returned by `action` is executed, and there was no action.
  //   - `timeout` and a leading <Record> are not present on the working call.
  //
  // Set INBOUND_RECORD=true to put session recording back once the leg connects
  // reliably; add it as a sibling *before* <Dial>, never nested, or FreeSWITCH
  // rejects the document and the caller hears a bogus "Busy".
  const inboundRecord = process.env.INBOUND_RECORD === "true"
    ? `  <Record recordSession="true" redirect="false" playBeep="false" fileFormat="mp3"\n    callbackUrl="${publicBaseUrl}/recording-ready?${agentQs}" callbackMethod="POST"/>\n`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
${inboundRecord}  <Dial${callerIdAttr}>
${destinations.join("\n")}
  </Dial>
  <Speak>Sorry, no one is available to take your call right now. Please leave a message after the beep.</Speak>
  <Record maxLength="120" timeout="10" finishOnKey="#" playBeep="true" fileFormat="mp3"
    callbackUrl="${publicBaseUrl}/recording-ready?${agentQs}" callbackMethod="POST"/>
  <Speak>Thank you. Goodbye.</Speak>
  <Hangup/>
</Response>`;
}

function vobizXmlGatherReply(speechText, turn, publicBaseUrl) {
  const heard = (speechText || "").trim();
  const heardLine = heard ? `You said: ${escapeXml(heard)}.` : "I did not catch that clearly.";

  if (turn >= 3) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Speak>${heardLine} That is three rounds, thanks for testing. Goodbye.</Speak>
  <Hangup/>
</Response>`;
  }

  const nextTurn = turn + 1;
  const gatherAction = `${publicBaseUrl}/gather-response?turn=${nextTurn}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather action="${gatherAction}" method="POST" inputType="speech"
    executionTimeout="12" speechTimeout="3" redirect="true">
    <Speak>${heardLine} Go ahead, say something else.</Speak>
  </Gather>
  <Speak>${heardLine} I did not hear anything else. Ending the test call now. Goodbye.</Speak>
  <Hangup/>
</Response>`;
}

function escapeXml(str) {
  return str.replace(/[<>&'"]/g, c => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  }[c]));
}

function withCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
        return;
      } catch {
        // Some clients (e.g. Zoho Deluge's postUrl with a Map) send
        // form-encoded data even when Content-Type says JSON — fall
        // back to parsing it that way instead of failing outright.
      }
      try {
        resolve(Object.fromEntries(new URLSearchParams(raw)));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function handleLogin(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }
  const { agentId, authId, authToken } = body;
  if (!agentId || !authId || !authToken) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "agentId, authId, and authToken are all required" }));
    return;
  }

  const headers = vobizAuthHeaders(authId, authToken);
  const meRes = await fetch("https://api.vobiz.ai/api/v1/auth/me", { headers });
  if (!meRes.ok) {
    console.warn(`[backend] login failed for agentId=${agentId} — VoBiz rejected the credentials (${meRes.status})`);
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "VoBiz rejected that Auth ID / Auth Token" }));
    return;
  }

  const numbersRes = await fetch(
    `https://api.vobiz.ai/api/v1/Account/${encodeURIComponent(authId)}/numbers`,
    { headers },
  );
  const numbersJson = await numbersRes.json();
  const numbers = (numbersJson.items || []).map(n => n.e164).filter(Boolean);

  agentSessions.set(agentId, { authId, authToken, from: numbers[0] || null, numbers });
  console.log(`[backend] ${agentId} logged in as ${authId} — ${numbers.length} number(s) on the account`);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, numbers, selected: numbers[0] || null }));
}

async function handleSelectNumber(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }
  const { agentId, number } = body;
  const session = agentId && agentSessions.get(agentId);
  if (!session) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not logged in — call /login first" }));
    return;
  }
  if (!session.numbers.includes(number)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "that number isn't on this account" }));
    return;
  }
  session.from = number;
  console.log(`[backend] ${agentId} switched their outgoing number to ${number}`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, selected: number }));
}

function handleSession(req, res, agentId) {
  const session = agentSessions.get(agentId);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(
    session
      ? { loggedIn: true, authId: session.authId, from: session.from, numbers: session.numbers }
      : { loggedIn: false },
  ));
}

async function handleStartCall(req, res) {
  const publicBaseUrl = getPublicBaseUrl();
  if (!publicBaseUrl) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "tunnel is not up yet — check backend/tunnel-url.txt" }));
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  const { to, agentId, platform } = body;
  if (!to) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing 'to' number" }));
    return;
  }
  if (!agentId || !getAgent(agentId)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `unknown agentId '${agentId}' — check backend/agents.json` }));
    return;
  }
  const session = agentSessions.get(agentId);
  if (!session) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not logged in — log in with a VoBiz Auth ID and Auth Token first" }));
    return;
  }
  if (!session.from) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "no outgoing number selected yet" }));
    return;
  }
  if (!platform) {
    // No platform declared — we will not guess. Recording/CDR still work,
    // but the sync-back step is skipped entirely for this call rather than
    // risk writing it into the wrong CRM.
    console.warn("[backend] /start-call with no 'platform' — sync-back will be skipped for this call");
  }

  const { status, json } = await placeVobizCall({ to, agentId, session, platform, publicBaseUrl });
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(json));
}

/**
 * Places the actual outbound call. Extracted from handleStartCall so the
 * Zoho PhoneBridge click-to-dial endpoint can place a call the same way
 * rather than reimplementing (and drifting from) the dial contract — that
 * contract is subtle enough that having two copies would be a liability.
 *
 * Customer-first dialing. An earlier attempt reversed this — REST-dialing
 * the agent's SIP URI first so the agent would already be live before the
 * customer's phone rang — but VoBiz answers that with "Endpoint Not
 * Registered" (cause 2020) every time and never dials the customer at all:
 * the REST `to` field routes out over SIP trunking and never consults the
 * registrar. Reaching a registered WebRTC browser is specifically what
 * <Dial><User> is for, so the agent leg has to be created from the answer
 * XML instead (see handleAnswer).
 */
async function placeVobizCall({ to, agentId, session, platform, publicBaseUrl }) {
  const answerUrl = `${publicBaseUrl}/answer?agentId=${encodeURIComponent(agentId)}`;
  const params = new URLSearchParams({
    to,
    from: session.from,
    answer_url: answerUrl,
    answer_method: "POST",
  });

  const auth = Buffer.from(`${session.authId}:${session.authToken}`).toString("base64");
  const vobizRes = await fetch(
    `https://api.vobiz.ai/api/v1/Account/${session.authId}/Call/`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
  );
  const vobizJson = await vobizRes.json();
  console.log("[backend] VoBiz Call API response:", vobizRes.status, vobizJson);

  if (platform && vobizJson.request_uuid) {
    callPlatform.set(vobizJson.request_uuid, platform);
    console.log(`[backend] tagged call ${vobizJson.request_uuid} as platform=${platform}`);
  }

  if (vobizJson.request_uuid) {
    // Lets agent-phone.html (Zoho) find out a call is happening at all —
    // it never sees /start-call itself, since Zoho's click-to-dial and the
    // older Deluge button both call it server-side, not from a browser tab.
    pushAgentEvent(agentId, { type: "call-started", callUuid: vobizJson.request_uuid, to });
  }

  return { status: vobizRes.status, json: vobizJson };
}

// answer_url for the inbound Application (see handleSetupInbound below).
// agentId is baked into the URL at Application-creation time — VoBiz just
// echoes it back on every hit, so no lookup/guessing is needed here.
async function handleInboundAnswer(req, res, url) {
  const agentId = url.searchParams.get("agentId");
  const agent = agentId && getAgent(agentId);
  const publicBaseUrl = getPublicBaseUrl();
  // Only for the caller's number and the CallUUID, to show in the softphone —
  // the routing decision itself comes from agentId on the URL.
  let body;
  try { body = await readJsonBody(req); } catch { body = {}; }
  if (!agent || !publicBaseUrl) {
    console.warn(`[backend] /inbound-answer misconfigured — agentId=${agentId} agentFound=${Boolean(agent)} tunnelUp=${Boolean(publicBaseUrl)}`);
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Speak>This number is not configured yet.</Speak><Hangup/></Response>`);
    return;
  }
  console.log(`[backend] inbound call — ringing agent "${agentId}" (${agent.displayName})`);

  // Tell the softphone that a call is being routed to it, before the XML goes
  // back. Without this an inbound call that VoBiz never delivers is completely
  // invisible in the browser — no ring, no error, nothing in the log — and it
  // looks like the panel is broken rather than like the INVITE never arrived.
  // The page starts a timer on this and says so out loud if no SIP session
  // follows. See ISSUES.md #1.
  const inboundEvent = (body.Event || body.event || "");
  if (inboundEvent !== "Hangup") {
    pushAgentEvent(agentId, {
      type: "inbound-routed",
      from: body.CallerName || body.From || body.from || "unknown",
      callUuid: body.CallUUID || body.call_uuid || null,
    });
  }

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(vobizXmlInboundToAgent(agent, agentId, publicBaseUrl, body.To || body.to));
}

// One-time setup action (triggered by a button in the panel, not run
// automatically): creates a VoBiz Application pointed at /inbound-answer
// and attaches this agent's currently-selected number to it. Real,
// account-mutating VoBiz API calls — only runs when explicitly asked for.
async function handleSetupInbound(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }
  const { agentId } = body;
  const session = agentId && agentSessions.get(agentId);
  if (!session) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "log in first, then enable inbound calls" }));
    return;
  }
  if (!session.from) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "no number selected on this account yet" }));
    return;
  }
  const publicBaseUrl = getPublicBaseUrl();
  if (!publicBaseUrl) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "tunnel is not up yet — check backend/tunnel-url.txt" }));
    return;
  }

  const headers = { ...vobizAuthHeaders(session.authId, session.authToken), "Content-Type": "application/json" };
  const answerUrl = `${publicBaseUrl}/inbound-answer?agentId=${encodeURIComponent(agentId)}`;
  const appName = `VobizInbound_${agentId}`.replace(/[^A-Za-z0-9_-]/g, "");

  const appRes = await fetch(`https://api.vobiz.ai/api/v1/Account/${session.authId}/Application/`, {
    method: "POST",
    headers,
    body: JSON.stringify({ app_name: appName, answer_url: answerUrl, answer_method: "POST" }),
  });
  const appText = await appRes.text();
  console.log(`[backend] /setup-inbound: create Application -> ${appRes.status}`, appText.slice(0, 500));
  let appJson;
  try {
    appJson = JSON.parse(appText);
  } catch {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: `VoBiz returned a non-JSON response (status ${appRes.status}) when creating the Application`,
      rawBody: appText.slice(0, 500),
    }));
    return;
  }
  if (!appRes.ok || !appJson.app_id) {
    console.error("[backend] /setup-inbound: create Application failed:", appRes.status, appJson);
    res.writeHead(appRes.status === 200 ? 502 : appRes.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "could not create VoBiz application", details: appJson }));
    return;
  }

  const encodedNumber = encodeURIComponent(session.from);
  const attachRes = await fetch(
    `https://api.vobiz.ai/api/v1/Account/${session.authId}/numbers/${encodedNumber}/application`,
    { method: "POST", headers, body: JSON.stringify({ application_id: appJson.app_id }) },
  );
  const attachText = await attachRes.text();
  console.log(`[backend] /setup-inbound: attach-number -> ${attachRes.status}`, attachText.slice(0, 500));
  let attachJson;
  try {
    attachJson = attachText ? JSON.parse(attachText) : {};
  } catch {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: `VoBiz returned a non-JSON response (status ${attachRes.status}) when attaching the number`,
      rawBody: attachText.slice(0, 500),
      appId: appJson.app_id,
    }));
    return;
  }
  if (!attachRes.ok) {
    console.error("[backend] /setup-inbound: attach-number failed:", attachRes.status, attachJson);
    res.writeHead(attachRes.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "application created but attaching the number failed",
      details: attachJson,
      appId: appJson.app_id,
    }));
    return;
  }

  console.log(`[backend] inbound routing live — ${session.from} -> app ${appJson.app_id} -> agent ${agentId}`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, appId: appJson.app_id, number: session.from, answerUrl }));
}

async function handleAnswer(req, res, url) {
  // Fires once the agent's own SIP leg (dialed directly by /start-call,
  // agent-first) has already answered — so this is the moment to bridge in
  // the real customer as the B-leg. Pure human-to-human: no AI assistant in
  // this path, and no double-ringing for the customer, since the agent's
  // side was already live before their phone even started ringing.
  // Set USE_VAPI_BRIDGE=true to restore the earlier Vapi-assistant bridge
  // for CRMs/tests that still want it (dials the agent leg the old way).
  //
  // VoBiz's own answer_url callback carries "From" — the exact caller ID
  // that was used to place THIS call — so the Dial's callerId is read from
  // there instead of one fixed env var. That's what makes this work
  // correctly no matter which logged-in account's number placed the call.
  // VOBIZ_FROM_NUMBER is kept only as a last-resort fallback.
  const agentId = url.searchParams.get("agentId");
  const session = agentId && agentSessions.get(agentId);

  // The signature check runs only when this agent has a live session (that's
  // the only place an auth token to verify against exists). That made it
  // invisible during development — logged out, every call routed fine; log
  // in, and every call was hung up the instant the customer answered, with
  // no audible clue why. It fails closed on a scheme VoBiz doesn't document,
  // so a mismatch here is at least as likely to be our HMAC construction as
  // a forged request.
  //
  // Default is now verify-and-warn: route the call, but say loudly that the
  // signature didn't check out. Set REQUIRE_VOBIZ_SIGNATURE=true to restore
  // the strict behaviour once the signing scheme is confirmed against a real
  // VoBiz callback (see the header dump in verifyVobizSignature).
  if (session && !verifyVobizSignature(req, url, session.authToken)) {
    if (process.env.REQUIRE_VOBIZ_SIGNATURE === "true") {
      console.warn(`[backend] /answer signature check FAILED for agentId=${agentId} — REQUIRE_VOBIZ_SIGNATURE=true, refusing to route this call`);
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      return;
    }
    console.warn(`[backend] /answer signature check FAILED for agentId=${agentId} — routing the call anyway (set REQUIRE_VOBIZ_SIGNATURE=true to block instead)`);
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }
  const callerId = body.From || VOBIZ_FROM_NUMBER;
  const publicBaseUrl = getPublicBaseUrl();

  // VoBiz posts the end-of-call notification to this same URL when no separate
  // hangup_url is configured, and it must be acknowledged, not answered with
  // call instructions. Confirmed on a live call: the second request of every
  // call carried Event=Hangup / CallStatus=completed, and we replied with the
  // full <Dial> document for a call that had already ended — which is what
  // sent Zoho a second `answered` for one call. Vobiz's own WebRTC demo
  // short-circuits this exact case; see also the note in its README that a
  // hangup URL pointing at the answer handler "would otherwise return <Dial>
  // XML after the call ended".
  if ((body.Event || "") === "Hangup") {
    console.log(`[backend] /answer — Event=Hangup for ${body.CallUUID || "?"}, acknowledging`);
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
    return;
  }

  if (process.env.USE_VAPI_BRIDGE === "true") {
    console.log(`[backend] /answer — dialing Vapi assistant as ${callerId} (signature ${session ? "verified" : "skipped, no session"})`);
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(vobizXmlDialVapi(publicBaseUrl, callerId, agentId));
    return;
  }

  const agent = agentId && getAgent(agentId);
  if (!agent) {
    console.warn(`[backend] /answer — no agent found for agentId=${agentId}, cannot bridge to a human`);
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Speak>This call cannot be connected right now.</Speak><Hangup/></Response>`);
    return;
  }
  console.log(
    `[backend] /answer — customer answered, now ringing agent "${agentId}" (${agent.displayName}) ` +
    `as callerId ${callerId} [Event=${body.Event || "?"} CallStatus=${body.CallStatus || "?"}] ` +
    `(signature ${session ? "verified" : "skipped, no session"})`,
  );

  // Zoho PhoneBridge: the customer picking up is the "answered" transition.
  // Zoho drives its own call bar from these updates, so a missed one leaves
  // the rep looking at a call that has already moved on.
  //
  // Only ever once per call. VoBiz can fetch the answer URL more than once for
  // a single call (see /dial-result), and re-reporting `answered` both
  // duplicates the event in Zoho's call bar and moves the clock the final
  // duration is measured from. The first answer is the true one.
  const pbCallUuid = body.CallUUID || body.call_uuid || body.RequestUUID;
  const tracked = pbCallUuid && zohoPhoneBridge.getTrackedCall(pbCallUuid);
  if (tracked && tracked.answeredAtMs) {
    console.log(`[zoho-pb] ${tracked.callId} was already answered at ${new Date(tracked.answeredAtMs).toISOString()} — not reporting it twice`);
  } else if (tracked) {
    zohoPhoneBridge.updateTrackedCall(pbCallUuid, { answeredAtMs: Date.now() });
    zohoPhoneBridge.notifyCall({
      orgId: tracked.orgId, type: tracked.type, state: "answered",
      callId: tracked.callId, from: tracked.from, to: tracked.to,
      zohoUser: tracked.zohoUser, credentials: pbCredentials(),
    }).catch(err => console.error("[zoho-pb] answered notify failed:", err.message));
  }

  // Which leg is the browser on?
  //
  // `From` is a SIP URI (or RouteType=sip) when the agent's softphone placed
  // the INVITE itself. Those calls need the customer dialled outward; only a
  // genuine PSTN leg needs bridging back into the browser.
  const answerFrom = String(body.From || body.from || "");
  const answerRouteType = String(body.RouteType || body.routetype || "").toLowerCase();
  if (answerFrom.startsWith("sip:") || answerRouteType === "sip") {
    const customer = body.To || body.to;
    console.log(`[backend] /answer — browser is the A leg, dialling out to ${customer}`);

    // This is the first time VoBiz tells us the CallUUID for a call the
    // softphone placed, so it is where a pending Zoho call gets bound to it.
    // Zoho keys its call bar off callId, so the id minted at click-to-dial time
    // is carried over rather than replaced.
    const pending = pendingBrowserCalls.get(agentId);
    const browserCallUuid = body.CallUUID || body.call_uuid || body.RequestUUID;
    if (pending && browserCallUuid && !zohoPhoneBridge.getTrackedCall(browserCallUuid)) {
      pendingBrowserCalls.delete(agentId);
      zohoPhoneBridge.trackCall(browserCallUuid, {
        orgId: pending.orgId, callId: pending.callId, agentId,
        zohoUser: pending.zohoUser, type: pending.type,
        from: pending.from, to: pending.to,
        startedAtMs: Date.now(),
      });
      console.log(`[zoho-pb] bound ${pending.callId} to CallUUID ${browserCallUuid}`);
    }
    res.writeHead(200, { "Content-Type": "text/xml" });
    // The A leg's own caller ID is the SIP username here, which is not a
    // dialable CLI — use the agent's selected number instead.
    const outboundCallerId = (session && session.from) || VOBIZ_FROM_NUMBER;
    res.end(vobizXmlDialCustomer(customer, outboundCallerId, agentId, publicBaseUrl));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(vobizXmlDialAgent(agent, agentId, publicBaseUrl, callerId));
}

async function handleGatherResponse(req, res, url) {
  const turn = parseInt(url.searchParams.get("turn") || "1", 10);
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }
  const speechText = body.Speech || body.speech || "";
  console.log(`[backend] /gather-response turn=${turn} heard:`, speechText || "(nothing)");
  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(vobizXmlGatherReply(speechText, turn, getPublicBaseUrl()));
}

async function handleDialResult(req, res, url) {
  const agentId = url.searchParams.get("agentId");
  const session = agentId && agentSessions.get(agentId);

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }

  // Every reply from here is an empty <Response></Response>, never JSON.
  // This is a Dial `action` URL with redirect="false": VoBiz's docs say the
  // handler "must return an empty <Response></Response>, or it will interrupt
  // a flow that has already moved on". Answering JSON did exactly that — a
  // live call on 16 Sep re-ran the whole answer document after the Dial
  // finished, so the customer was dialled once but /answer fired twice, Zoho
  // got two `answered` notifications for one call, and the duration was
  // measured from the second one (2s for a 4s call).
  const endDialResult = () => {
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);
  };

  if (session && !verifyVobizSignature(req, url, session.authToken)) {
    console.warn(`[backend] /dial-result signature check FAILED for agentId=${agentId} — ignoring`);
    endDialResult();
    return;
  }

  console.log(
    `[backend] agent leg finished — DialStatus=${body.DialStatus} ` +
    `DialHangupCause=${body.DialHangupCause} DialRingStatus=${body.DialRingStatus} ` +
    `(signature ${session ? "verified" : "skipped, no session"})`,
  );

  // This is the definitive "the call is over" moment — push it straight to
  // any browser watching, instead of making it poll every few seconds.
  if (agentId) {
    pushAgentEvent(agentId, { type: "call-ended", status: body.DialStatus, hangupCause: body.DialHangupCause });
  }

  // Zoho PhoneBridge safety net. The recording webhook is the preferred place
  // to close a call out (it carries the audio), but it only fires for calls
  // that actually recorded something — a no-answer or a failed bridge never
  // produces one, and without this Zoho would show that call as live forever.
  // finalizeZohoPhoneBridgeCall is idempotent, so if the recording does land
  // first this timer finds nothing to do.
  const endedCallUuid = body.CallUUID || body.call_uuid || body.RequestUUID;
  if (endedCallUuid && zohoPhoneBridge.getTrackedCall(endedCallUuid)) {
    setTimeout(() => {
      finalizeZohoPhoneBridgeCall(endedCallUuid, { agentId })
        .catch(err => console.error("[zoho-pb] fallback finalize failed:", err.message));
    }, ZOHO_PB_RECORDING_GRACE_MS).unref();
  }

  endDialResult();
}

// Lets a CTI panel poll "is this call still going?" without needing VoBiz
// credentials in the browser. 200 from VoBiz means still live; anything else
// (typically 404) means it ended — VoBiz moves it to the finalized CDR.
async function handleCallStatus(req, res, callUuid, agentId) {
  const session = agentId && agentSessions.get(agentId);
  if (!session) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not logged in" }));
    return;
  }
  const vobizRes = await fetch(
    `https://api.vobiz.ai/api/v1/Account/${session.authId}/Call/${callUuid}/?status=live`,
    { headers: vobizAuthHeaders(session.authId, session.authToken) },
  );
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ active: vobizRes.ok }));
}

// Opens a long-lived Server-Sent-Events connection for one agent. Opened
// once, when a panel/tab loads — from then on it just waits and gets told
// "call-started" / "call-ended" as they happen, no polling.
function handleCallEvents(req, res, agentId) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
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

// Arrives up to several minutes after the call (per Vobiz's own docs) —
// the recording, and any CRM record for it, are already long since created
// by the time this shows up, so this only ever appends, never creates.
async function handleTranscriptionReady(req, res, url) {
  const agentId = url.searchParams.get("agentId");
  const session = agentId && agentSessions.get(agentId);

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }

  if (session && !verifyVobizSignature(req, url, session.authToken)) {
    console.warn(`[backend] /transcription-ready signature check FAILED for agentId=${agentId} — ignoring`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: false }));
    return;
  }

  console.log("[backend] transcription ready:", body);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ received: true }));

  if (body.transcription && body.recording_id) {
    appendTranscriptToZohoCall(body.recording_id, body.transcription).catch(err => {
      console.error("[backend] Zoho transcript update failed:", err);
    });
  }
}

async function handleRecordingReady(req, res, url) {
  const agentId = url.searchParams.get("agentId");
  const session = agentId && agentSessions.get(agentId);

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    body = {};
  }

  if (session && !verifyVobizSignature(req, url, session.authToken)) {
    console.warn(`[backend] /recording-ready signature check FAILED for agentId=${agentId} — ignoring`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: false }));
    return;
  }

  console.log("[backend] recording ready:", body);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ received: true }));

  const callUuid = body.CallUUID || body.ALegRequestUUID;
  const platform = callUuid ? callPlatform.get(callUuid) : null;
  if (callUuid) callPlatform.delete(callUuid); // one-shot lookup, don't leak memory

  if (platform === "zoho-phonebridge") {
    // The recording is the last thing to arrive, and `ended` is the only
    // callnotify state that carries `voiceuri` — so this is where the call
    // log lands, recording attached. finalizeZohoPhoneBridgeCall is
    // idempotent, so whichever of this and the dial-result timer gets here
    // first wins and the other becomes a no-op.
    finalizeZohoPhoneBridgeCall(callUuid, {
      recordingId: body.RecordingID || body.recording_id,
      agentId,
      durationSec: Number(body.RecordingDuration || body.recording_duration || 0) || null,
    }).catch(err => console.error("[zoho-pb] final call log failed:", err.message));
  } else if (platform === "zoho") {
    syncCallToZoho(body).catch(err => {
      console.error("[backend] Zoho call sync failed:", err);
    });
  } else if (platform === "salesforce") {
    syncCallToSalesforce(body).catch(err => {
      console.error("[backend] Salesforce call sync failed:", err);
    });
  } else if (platform === "freshdesk") {
    // Freshdesk's own sync-back isn't built yet — intentionally a no-op for
    // now rather than falling through to some other CRM.
    console.log("[backend] call was placed via Freshdesk — no Freshdesk sync implemented yet, skipping");
  } else {
    console.log(`[backend] no known platform for call ${callUuid} (got "${platform}") — skipping CRM sync`);
  }
}

// Lets the panel show recent calls without ever holding a VoBiz Auth
// Token itself — same "backend already has the credentials" pattern as
// /call-status. Wraps the real Recent CDRs endpoint 1:1.
async function handleListCdrs(req, res, agentId, url) {
  const session = agentId && agentSessions.get(agentId);
  if (!session) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not logged in" }));
    return;
  }
  const limit = url.searchParams.get("limit") || "20";
  const vobizRes = await fetch(
    `https://api.vobiz.ai/api/v1/Account/${session.authId}/cdr/recent?limit=${encodeURIComponent(limit)}`,
    { headers: vobizAuthHeaders(session.authId, session.authToken) },
  );
  const json = await vobizRes.json();
  res.writeHead(vobizRes.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(json));
}

// Same wrapping for the recordings list — the panel cross-references this
// with the CDR list by call_uuid to know which calls have a "Play" button.
async function handleListRecordings(req, res, agentId, url) {
  const session = agentId && agentSessions.get(agentId);
  if (!session) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not logged in" }));
    return;
  }
  const limit = url.searchParams.get("limit") || "20";
  const vobizRes = await fetch(
    `https://api.vobiz.ai/api/v1/Account/${session.authId}/Recording/?limit=${encodeURIComponent(limit)}`,
    { headers: vobizAuthHeaders(session.authId, session.authToken) },
  );
  const json = await vobizRes.json();
  res.writeHead(vobizRes.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(json));
}

// The auth-proxy fix for the browser-<audio>-can't-send-headers gotcha:
// looks up the recording's real file URL (itself an authenticated call),
// then fetches THAT file with the same auth headers and streams the bytes
// straight through. The browser only ever talks to this backend — it
// never needs a VoBiz credential of its own.
/**
 * Streams a recording back, proxying VoBiz's authenticated media URL.
 *
 * `allowAccountFallback` is for callers that have already authenticated the
 * request some other way — today that is only the HMAC-signed `voiceuri` we
 * hand Zoho. Zoho fetches that link hours or days later, with no VoBiz
 * credentials and no browser session anywhere in the picture, so requiring a
 * live agent session there meant every recording Zoho tried to play answered
 * 401 and the call log arrived without audio. The plain /recording-audio route
 * keeps requiring a session, since nothing else authenticates it.
 */
async function handleRecordingAudio(req, res, agentId, recordingId, { allowAccountFallback = false } = {}) {
  const session = agentId && agentSessions.get(agentId);
  const credentials = session || (allowAccountFallback && VOBIZ_AUTH_ID && VOBIZ_AUTH_TOKEN
    ? { authId: VOBIZ_AUTH_ID, authToken: VOBIZ_AUTH_TOKEN }
    : null);
  if (!credentials) {
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("not logged in");
    return;
  }
  const headers = vobizAuthHeaders(credentials.authId, credentials.authToken);

  const metaRes = await fetch(
    `https://api.vobiz.ai/api/v1/Account/${credentials.authId}/Recording/${encodeURIComponent(recordingId)}/`,
    { headers },
  );
  if (!metaRes.ok) {
    res.writeHead(metaRes.status, { "Content-Type": "text/plain" });
    res.end("recording not found");
    return;
  }
  const meta = await metaRes.json();
  if (!meta.recording_url) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("no recording_url on this recording yet");
    return;
  }

  const fileRes = await fetch(meta.recording_url, { headers });
  if (!fileRes.ok || !fileRes.body) {
    res.writeHead(fileRes.status || 502, { "Content-Type": "text/plain" });
    res.end("could not fetch the recording file");
    return;
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

// --- Zoho call sync: push the finished call + recording onto the matching Contact ---

async function getZohoAccessToken() {
  const stored = JSON.parse(fs.readFileSync(ZOHO_TOKENS_FILE, "utf8"));
  const ageMs = Date.now() - (stored.received_at || 0);
  const expiresInMs = (stored.expires_in || 3600) * 1000;
  if (ageMs < expiresInMs - 5 * 60 * 1000) {
    return stored.access_token; // still fresh (5 min safety margin)
  }

  console.log("[backend] Zoho access token expired, refreshing...");
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: ZOHO_TEST_CLIENT_ID,
    client_secret: ZOHO_TEST_CLIENT_SECRET,
    refresh_token: stored.refresh_token,
  });
  const res = await fetch(`${ZOHO_ACCOUNTS_DOMAIN}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const refreshed = await res.json();
  if (!refreshed.access_token) {
    throw new Error(`Zoho token refresh failed: ${JSON.stringify(refreshed)}`);
  }
  const merged = { ...stored, ...refreshed, received_at: Date.now() };
  fs.writeFileSync(ZOHO_TOKENS_FILE, JSON.stringify(merged, null, 2));
  return merged.access_token;
}

// Match by the last 10 digits so it doesn't matter whether Zoho stored the
// number with a country code, a leading +, or spaces.
function last10Digits(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

async function findZohoContactByPhone(phone, accessToken) {
  const digits = last10Digits(phone);
  const url = `${ZOHO_API_DOMAIN}/crm/v2/Contacts/search?phone=${digits}`;
  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  if (res.status === 204) return null; // Zoho returns 204 for no matches
  const json = await res.json();
  if (!res.ok) {
    console.error("[backend] Zoho contact search failed:", res.status, json);
    return null;
  }
  return (json.data && json.data[0]) || null;
}

// Previously: no match meant the call just vanished, never logged anywhere.
// A real telephony integration doesn't drop calls it can't recognize — it
// creates the record. Last_Name is required by Zoho for a Contact; there's
// no name to give it yet, so it's marked clearly as unidentified rather than
// guessed at.
async function createZohoContact(phone, accessToken) {
  const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v2/Contacts`, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: [{ Last_Name: "Unknown Caller (via VoBiz)", Phone: phone }] }),
  });
  const json = await res.json();
  const created = json.data && json.data[0];
  if (!res.ok || !created || created.status !== "success") {
    console.error("[backend] Zoho contact auto-create failed:", res.status, JSON.stringify(json));
    return null;
  }
  console.log(`[backend] Zoho: no existing contact for ${phone} — created one (${created.details.id})`);
  return { id: created.details.id };
}

// Lets /transcription-ready (which arrives up to several minutes after the
// call, per Vobiz's own docs) find and update the Call record that
// /recording-ready already created. Keyed by recording_id — the one call
// identifier Vobiz's docs actually confirm is present on both the
// recording-ready and transcription-ready payloads. One-shot.
const zohoCallRecords = new Map(); // recordingId -> zoho Call record id

// Zoho CRM rejects standard ISO datetimes ("...484Z") — it wants no
// milliseconds and an explicit numeric offset, e.g. "2026-08-27T13:20:20+05:30".
function toZohoDateTime(epochMs) {
  const offsetMinutes = 330; // Asia/Kolkata (+05:30) — this Zoho org's timezone
  const local = new Date(epochMs + offsetMinutes * 60000);
  const pad = n => String(n).padStart(2, "0");
  const y = local.getUTCFullYear();
  const mo = pad(local.getUTCMonth() + 1);
  const d = pad(local.getUTCDate());
  const h = pad(local.getUTCHours());
  const mi = pad(local.getUTCMinutes());
  const s = pad(local.getUTCSeconds());
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+05:30`;
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

async function syncCallToZoho(recordingWebhook) {
  if (!recordingWebhook || !recordingWebhook.To) {
    console.log("[backend] Zoho sync skipped — no 'To' number on recording webhook");
    return;
  }

  const accessToken = await getZohoAccessToken();
  let contact = await findZohoContactByPhone(recordingWebhook.To, accessToken);
  if (!contact) {
    contact = await createZohoContact(recordingWebhook.To, accessToken);
  }
  if (!contact) {
    console.log(`[backend] Zoho sync skipped — no Contact found or created for ${recordingWebhook.To}`);
    return;
  }

  const durationSec = Number(recordingWebhook.RecordingDuration || 0);
  const callRecord = {
    Subject: "VoBiz test call",
    Call_Type: "Outbound",
    Call_Duration: formatDuration(durationSec),
    Call_Start_Time: toZohoDateTime(Number(recordingWebhook.RecordingStartMs || Date.now())),
    Who_Id: { id: contact.id },
    Description:
      `Placed via Vobiz. Call UUID: ${recordingWebhook.CallUUID}\n` +
      `Recording (${durationSec}s): ${recordingWebhook.RecordFile || recordingWebhook.RecordUrl}`,
  };

  const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v2/Calls`, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: [callRecord] }),
  });
  const json = await res.json();
  console.log("[backend] Zoho Call create response:", res.status, JSON.stringify(json));

  const created = json.data && json.data[0];
  if (res.ok && created && created.status === "success" && recordingWebhook.RecordingID) {
    zohoCallRecords.set(recordingWebhook.RecordingID, created.details.id);
  }
}

// Appends the transcript onto the Call record /recording-ready already
// created, once it arrives (can be several minutes later, per Vobiz's docs).
async function appendTranscriptToZohoCall(recordingId, transcription) {
  const recordId = zohoCallRecords.get(recordingId);
  if (!recordId) {
    console.log(`[backend] Zoho transcript skipped — no tracked Call record for recording ${recordingId} (not a Zoho call, or already cleaned up)`);
    return;
  }
  zohoCallRecords.delete(recordingId); // one-shot

  const accessToken = await getZohoAccessToken();

  // PUT replaces the whole field, so fetch the description /recording-ready
  // already wrote and append to it rather than clobbering it.
  const getRes = await fetch(`${ZOHO_API_DOMAIN}/crm/v2/Calls/${recordId}`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const getJson = await getRes.json();
  const existing = (getJson.data && getJson.data[0] && getJson.data[0].Description) || "";
  const combined = `${existing}\n\nTranscript:\n${transcription}`;

  const res = await fetch(`${ZOHO_API_DOMAIN}/crm/v2/Calls/${recordId}`, {
    method: "PUT",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: [{ id: recordId, Description: combined }] }),
  });
  const json = await res.json();
  console.log("[backend] Zoho Call transcript update response:", res.status, JSON.stringify(json));
}

// --- Salesforce call sync: push the finished call + recording onto the matching Contact ---

function loadSalesforceTokens() {
  return JSON.parse(fs.readFileSync(SALESFORCE_TOKENS_FILE, "utf8"));
}

// Salesforce doesn't return an expires_in with the access token, so instead
// of tracking a TTL like Zoho, we just try the call and refresh-and-retry
// once on a 401 (session expired) — the standard pattern for this API.
async function salesforceRequest(path, options = {}) {
  let tokens = loadSalesforceTokens();
  const doFetch = accessToken =>
    fetch(`${tokens.instance_url}${path}`, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${accessToken}`,
      },
    });

  let res = await doFetch(tokens.access_token);
  if (res.status === 401) {
    console.log("[backend] Salesforce session expired, refreshing...");
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: SALESFORCE_CLIENT_ID,
      client_secret: SALESFORCE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
    });
    const refreshRes = await fetch(`${SALESFORCE_LOGIN_URL}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const refreshed = await refreshRes.json();
    if (!refreshed.access_token) {
      throw new Error(`Salesforce token refresh failed: ${JSON.stringify(refreshed)}`);
    }
    tokens = { ...tokens, ...refreshed };
    fs.writeFileSync(SALESFORCE_TOKENS_FILE, JSON.stringify(tokens, null, 2));
    res = await doFetch(tokens.access_token);
  }
  return res;
}

async function findSalesforceContactByPhone(phone) {
  const digits = last10Digits(phone);
  const soql = `SELECT Id FROM Contact WHERE Phone LIKE '%${digits}%' OR MobilePhone LIKE '%${digits}%' LIMIT 1`;
  const res = await salesforceRequest(`/services/data/v59.0/query?q=${encodeURIComponent(soql)}`);
  const json = await res.json();
  if (!res.ok) {
    console.error("[backend] Salesforce contact search failed:", res.status, json);
    return null;
  }
  return (json.records && json.records[0]) || null;
}

async function syncCallToSalesforce(recordingWebhook) {
  if (!recordingWebhook || !recordingWebhook.To) {
    console.log("[backend] Salesforce sync skipped — no 'To' number on recording webhook");
    return;
  }

  const contact = await findSalesforceContactByPhone(recordingWebhook.To);
  if (!contact) {
    console.log(`[backend] Salesforce sync skipped — no Contact found for ${recordingWebhook.To}`);
    return;
  }

  const durationSec = Number(recordingWebhook.RecordingDuration || 0);
  const task = {
    Subject: "VoBiz test call",
    TaskSubtype: "Call",
    Status: "Completed",
    CallType: "Outbound",
    CallDurationInSeconds: durationSec,
    ActivityDate: new Date().toISOString().slice(0, 10),
    WhoId: contact.Id,
    Description:
      `Placed via Vobiz. Call UUID: ${recordingWebhook.CallUUID}\n` +
      `Recording (${durationSec}s): ${recordingWebhook.RecordFile || recordingWebhook.RecordUrl}`,
  };

  const res = await salesforceRequest("/services/data/v59.0/sobjects/Task", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(task),
  });
  const json = await res.json();
  console.log("[backend] Salesforce Task create response:", res.status, JSON.stringify(json));
}

function handleZohoConnect(req, res) {
  const authUrl = new URL(`${ZOHO_ACCOUNTS_DOMAIN}/oauth/v2/auth`);
  authUrl.searchParams.set("scope", "ZohoCRM.users.READ,ZohoCRM.modules.ALL");
  authUrl.searchParams.set("client_id", ZOHO_TEST_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", ZOHO_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
}

async function handleZohoCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error || !code) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`Zoho login failed or was declined: ${error || "no code returned"}`);
    return;
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: ZOHO_TEST_CLIENT_ID,
    client_secret: ZOHO_TEST_CLIENT_SECRET,
    redirect_uri: ZOHO_REDIRECT_URI,
    code,
  });

  const tokenRes = await fetch(`${ZOHO_ACCOUNTS_DOMAIN}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const tokenJson = await tokenRes.json();
  console.log("[backend] Zoho token exchange response:", tokenRes.status, tokenJson);

  if (!tokenJson.access_token) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "token exchange failed", details: tokenJson }));
    return;
  }

  tokenJson.received_at = Date.now();
  fs.writeFileSync(ZOHO_TOKENS_FILE, JSON.stringify(tokenJson, null, 2));

  const whoamiRes = await fetch(`${ZOHO_API_DOMAIN}/crm/v2/users?type=CurrentUser`, {
    headers: { Authorization: `Zoho-oauthtoken ${tokenJson.access_token}` },
  });
  const whoamiJson = await whoamiRes.json();
  console.log("[backend] Zoho whoami response:", whoamiRes.status, whoamiJson);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    message: "Connected to Zoho successfully",
    tokenSaved: ZOHO_TOKENS_FILE,
    currentUser: whoamiJson,
  }, null, 2));
}

// ===========================================================================
// Zoho PhoneBridge V3
// ===========================================================================
//
// Server-to-server, multi-tenant, multi-datacentre. Distinct from the
// handleZohoConnect/handleZohoCallback pair above, which belongs to the older
// single-org Deluge experiment and stays as it is. See zoho-phonebridge.js.

/** Signed, time-limited recording URL. Zoho fetches this with no credentials
 *  of its own, so it cannot use /recording-audio (which needs a session). */
function signRecordingToken(agentId, recordingId, expiresAtMs) {
  return crypto
    .createHmac("sha256", RECORDING_URL_SECRET)
    .update(`${agentId}.${recordingId}.${expiresAtMs}`)
    .digest("hex");
}

function buildSignedRecordingUrl(agentId, recordingId, publicBaseUrl, ttlMs = 30 * 24 * 60 * 60 * 1000) {
  const expiresAt = Date.now() + ttlMs;
  const sig = signRecordingToken(agentId, recordingId, expiresAt);
  const qs = new URLSearchParams({ agentId, recordingId, expires: String(expiresAt), sig });
  return `${publicBaseUrl}/zoho/phonebridge/recording?${qs.toString()}`;
}

async function handleZohoPbRecording(req, res, url) {
  const agentId = url.searchParams.get("agentId");
  const recordingId = url.searchParams.get("recordingId");
  const expires = Number(url.searchParams.get("expires") || 0);
  const sig = url.searchParams.get("sig") || "";

  if (!agentId || !recordingId || !expires || Date.now() > expires) {
    res.writeHead(410, { "Content-Type": "text/plain" });
    res.end("recording link missing or expired");
    return;
  }
  const expected = signRecordingToken(agentId, recordingId, expires);
  const ok =
    sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!ok) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("bad signature");
    return;
  }
  // The signature IS the authentication for this route, so the proxy may fall
  // back to the account credentials — Zoho comes back for the audio long after
  // any agent session has gone.
  await handleRecordingAudio(req, res, agentId, recordingId, { allowAccountFallback: true });
}

async function handleZohoPbConnect(req, res, url) {
  if (!PB_CLIENT_ID || !PB_CLIENT_SECRET || !PB_REDIRECT_URI) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: "Zoho PhoneBridge is not configured",
      missing: {
        clientId: !PB_CLIENT_ID,
        clientSecret: !PB_CLIENT_SECRET,
        redirectUri: !PB_REDIRECT_URI,
      },
      hint: "set ZOHO_PB_CLIENT_ID / ZOHO_PB_CLIENT_SECRET / ZOHO_PB_REDIRECT_URI (or the ZOHO_TEST_* pair for local work)",
    }, null, 2));
    return;
  }
  // ?dc=in starts the consent flow at the client's OWN datacentre. Needed
  // when the client was registered at api-console.zoho.in (or .eu, etc.)
  // without Multi-DC enabled — such a client does not exist at
  // accounts.zoho.com and the flow dies with "invalid client". A real
  // Multi-DC partner client needs no override.
  const dc = url && url.searchParams.get("dc");
  let accountsDomain = null;
  if (dc) {
    try {
      accountsDomain = await zohoPhoneBridge.accountsDomainForLocation(dc);
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
  }

  const authUrl = zohoPhoneBridge.buildAuthUrl({
    clientId: PB_CLIENT_ID,
    redirectUri: PB_REDIRECT_URI,
    state: crypto.randomBytes(16).toString("hex"),
    accountsDomain,
  });
  console.log(`[zoho-pb] starting consent at ${accountsDomain || "https://accounts.zoho.com"}${dc ? ` (dc=${dc})` : ""}`);
  res.writeHead(302, { Location: authUrl });
  res.end();
}

async function handleZohoPbCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  // THE critical parameter. Zoho tells us which of its datacentres this
  // customer lives in; every later call for them must go to that one.
  const locationParam = url.searchParams.get("location");
  const accountsServer = url.searchParams.get("accounts-server");

  if (error || !code) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`Zoho PhoneBridge authorization failed: ${error || "no code returned"}`);
    return;
  }
  // `location` is the normal signal. When the flow was started directly at a
  // single datacentre (?dc=in, for a client without Multi-DC) Zoho may return
  // only `accounts-server` — so derive the location from it rather than
  // falling back to a hardcoded guess, which is the one thing Zoho prohibits.
  let resolvedLocation = locationParam;
  if (!resolvedLocation && accountsServer) {
    const locations = await zohoPhoneBridge.resolveServerInfo();
    const normalise = d => String(d).replace(/\/+$/, "").toLowerCase();
    resolvedLocation = Object.keys(locations).find(
      k => normalise(locations[k]) === normalise(accountsServer),
    ) || null;
    if (resolvedLocation) {
      console.log(`[zoho-pb] no 'location' param — derived "${resolvedLocation}" from accounts-server ${accountsServer}`);
    }
  }

  if (!resolvedLocation) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(
      "Zoho returned neither a 'location' parameter nor a recognisable " +
      `'accounts-server' (got: ${accountsServer || "none"}). Without one of those we ` +
      "cannot know which datacentre this org lives in, and hardcoding one is exactly " +
      "what Zoho prohibits.",
    );
    return;
  }
  const location = resolvedLocation;

  const tokens = await zohoPhoneBridge.exchangeCodeForTokens({
    code,
    location,
    clientId: PB_CLIENT_ID,
    clientSecret: PB_CLIENT_SECRET,
    redirectUri: PB_REDIRECT_URI,
  });

  // Identify the org so tokens are stored per-tenant. Zoho's own org id would
  // be ideal; the accounts-server + location pair is a stable stand-in until
  // the PhoneBridge partner credentials expose an org lookup.
  const orgId = url.searchParams.get("orgId") || `${location}:${tokens.apiDomain}`;

  zohoPhoneBridge.saveOrg(orgId, {
    ...tokens,
    connectedAt: new Date().toISOString(),
    accountsServer: accountsServer || tokens.accountsDomain,
  });

  console.log(
    `[zoho-pb] connected org ${orgId} — location=${location} ` +
    `accounts=${tokens.accountsDomain} api=${tokens.apiDomain} scope=${tokens.scope}`,
  );

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    message: "Connected to Zoho PhoneBridge",
    orgId,
    location,
    accountsDomain: tokens.accountsDomain,
    apiDomain: tokens.apiDomain,
    scope: tokens.scope,
    nextStep: `POST /zoho/phonebridge/register with { "orgId": "${orgId}", "agentId": "<your agent>" }`,
  }, null, 2));
}

/**
 * Manual OAuth completion, for the case where Zoho's registered redirect URI
 * points somewhere we cannot serve.
 *
 * Zoho registered VoBiz against https://integrations.vobiz.ai/oauth/zoho/callback
 * and will redirect ONLY there. That hostname does not exist yet, so the
 * browser lands on a dead page — but the authorization code and location are
 * right there in the URL bar, which is all we actually need. Paste that URL
 * here and the exchange completes normally.
 *
 * The code is valid for about a minute, hence a paste box rather than a
 * curl command.
 */
function handleZohoPbCompleteForm(req, res) {
  const page = `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Finish connecting Zoho</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 680px; margin: 0 auto; padding: 32px 20px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { color: #667; margin: 0 0 16px; }
  textarea { width: 100%; box-sizing: border-box; height: 110px; font: 13px/1.5 ui-monospace, monospace;
             padding: 10px; border: 1px solid #99a3b3; border-radius: 6px; }
  button { margin-top: 12px; padding: 10px 18px; font-size: 15px; border: 0; border-radius: 6px;
           background: #2563eb; color: #fff; cursor: pointer; }
  ol { color: #667; padding-left: 20px; }
  code { background: rgba(127,127,127,.15); padding: 1px 5px; border-radius: 3px; }
</style>
<h1>Finish connecting Zoho</h1>
<p>Zoho sends you to <code>integrations.vobiz.ai</code>, which isn't set up yet — so that page fails to load.
That's expected. The part we need is in the address bar.</p>
<ol>
  <li>On the failed page, click the browser's address bar and copy the <strong>whole URL</strong></li>
  <li>Paste it below and press Connect</li>
</ol>
<p><strong>Be quick</strong> — Zoho's authorization code expires about a minute after you approve.</p>
<form method="POST">
  <textarea name="callbackUrl" placeholder="https://integrations.vobiz.ai/oauth/zoho/callback?state=...&amp;code=...&amp;location=in" autofocus></textarea>
  <button type="submit">Connect</button>
</form>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
}

async function handleZohoPbComplete(req, res) {
  const body = await readJsonBody(req).catch(() => ({}));
  const pasted = (body.callbackUrl || body.url || "").trim();

  const fail = (status, message, hint) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message, hint }, null, 2));
  };

  if (!pasted) return fail(400, "No URL supplied");

  let parsed;
  try {
    // Accept either a full URL or just the query string.
    parsed = new URL(pasted.startsWith("http") ? pasted : `https://placeholder.invalid/?${pasted.replace(/^\?/, "")}`);
  } catch {
    return fail(400, "That doesn't parse as a URL", "Paste the whole address including https://");
  }

  const code = parsed.searchParams.get("code");
  const location = parsed.searchParams.get("location");
  const accountsServer = parsed.searchParams.get("accounts-server");
  const oauthError = parsed.searchParams.get("error");

  if (oauthError) return fail(400, `Zoho returned an error: ${oauthError}`);
  if (!code) return fail(400, "No 'code' in that URL", "Make sure you copied the URL from AFTER approving, not the consent page itself");

  let resolvedLocation = location;
  if (!resolvedLocation && accountsServer) {
    const locations = await zohoPhoneBridge.resolveServerInfo();
    const norm = d => String(d).replace(/\/+$/, "").toLowerCase();
    resolvedLocation = Object.keys(locations).find(k => norm(locations[k]) === norm(accountsServer)) || null;
  }
  if (!resolvedLocation) {
    return fail(400, "No 'location' in that URL", "Zoho should append &location=in (or us/eu/...) — copy the full URL");
  }

  let tokens;
  try {
    tokens = await zohoPhoneBridge.exchangeCodeForTokens({
      code,
      location: resolvedLocation,
      clientId: PB_CLIENT_ID,
      clientSecret: PB_CLIENT_SECRET,
      // MUST match the URI the code was issued against, byte for byte.
      redirectUri: PB_REDIRECT_URI,
    });
  } catch (err) {
    return fail(502, err.message, "'invalid_code' usually means it expired — codes last about a minute. Start the connect flow again.");
  }

  const orgId = `${resolvedLocation}:${tokens.apiDomain}`;
  zohoPhoneBridge.saveOrg(orgId, {
    ...tokens,
    connectedAt: new Date().toISOString(),
    accountsServer: accountsServer || tokens.accountsDomain,
  });
  console.log(`[zoho-pb] connected org ${orgId} via manual completion — location=${resolvedLocation} api=${tokens.apiDomain}`);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    message: "Connected to Zoho PhoneBridge",
    orgId,
    location: resolvedLocation,
    apiDomain: tokens.apiDomain,
    scope: tokens.scope,
    nextStep: `POST /zoho/phonebridge/register with { "orgId": "${orgId}", "agentId": "test-agent" }`,

    // Shown deliberately. This host's filesystem does not survive a restart,
    // so the connection is lost on every redeploy or wake-from-sleep unless
    // the refresh token is put into config. Saving these two values as
    // environment variables makes the connection durable — see
    // bootstrapOrgFromEnv.
    SAVE_THESE_TO_SURVIVE_RESTARTS: {
      warning: "Treat the refresh token as a password. It grants ongoing access to this Zoho org.",
      ZOHO_PB_REFRESH_TOKEN: tokens.refreshToken,
      ZOHO_PB_ORG_LOCATION: resolvedLocation,
    },
  }, null, 2));
}

/** Registers our click-to-dial endpoint with Zoho for one org. */
async function handleZohoPbRegister(req, res) {
  const body = await readJsonBody(req).catch(() => ({}));
  const { orgId, agentId } = body;
  const publicBaseUrl = getPublicBaseUrl();

  if (!orgId || !agentId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "orgId and agentId are both required" }));
    return;
  }
  if (!getAgent(agentId)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `unknown agentId '${agentId}'` }));
    return;
  }

  // Activate the PBX integration first. Zoho rejects clicktodial (and every
  // other PhoneBridge endpoint) with PBX_NOT_INTEGRATED until this has been
  // called — even though its admin screens already show the provider as
  // installed. It is idempotent, so calling it on every registration is
  // cheaper than tracking whether we have done it.
  const integration = await zohoPhoneBridge.integrate({ orgId, credentials: pbCredentials() });
  if (!integration.ok) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      registered: false,
      step: "integrate",
      error: "Zoho refused to activate the PBX integration",
      zohoResponse: integration.body,
      hint: "Confirm Vobiz Telephony is installed for this org in Zoho One > Marketplace > Telephony.",
    }, null, 2));
    return;
  }
  if (!publicBaseUrl) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "PUBLIC_BASE_URL is not set — Zoho needs a reachable URL" }));
    return;
  }

  // orgId and agentId are baked into the registered URI, so when Zoho calls
  // us we know both without needing a lookup table keyed on something Zoho
  // may or may not send.
  const clickToDialUri =
    `${publicBaseUrl}/zoho/phonebridge/clicktodial` +
    `?orgId=${encodeURIComponent(orgId)}&agentId=${encodeURIComponent(agentId)}`;

  const result = await zohoPhoneBridge.registerClickToDial({
    orgId,
    clickToDialUri,
    credentials: pbCredentials(),
  });

  // Now that the integration is active, Zoho will tell us who its users are.
  // Each carries a `zohouser` id — the handle callnotify needs to address an
  // event to one specific person, which is the prerequisite for per-agent
  // routing, transfers and ringing groups.
  const zohoUsers = result.ok
    ? await zohoPhoneBridge.listZohoUsers({ orgId, credentials: pbCredentials() })
    : [];

  res.writeHead(result.ok ? 200 : 502, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    registered: result.ok,
    integrationActivated: true,
    clickToDialUri,
    zohoResponse: result.body,
    zohoUsers,
  }, null, 2));
}

/**
 * Zoho calls THIS when a user clicks a phone number in their CRM.
 * Zoho sends the callee as `tonumber`.
 */
async function handleZohoPbClickToDial(req, res, url) {
  const orgId = url.searchParams.get("orgId");
  const agentId = url.searchParams.get("agentId");

  // Zoho posts form-encoded. readJsonBody already falls back to form parsing
  // (it had to, for Deluge), so it handles both without extra work here.
  const fields = await readJsonBody(req).catch(() => ({}));
  // Zoho may also append params to the URL rather than the body.
  for (const [k, v] of url.searchParams) if (!(k in fields)) fields[k] = v;

  const to = fields.tonumber || fields.toNumber || fields.to;
  const zohoUser = fields.zohouser || fields.zohoUser || null;

  console.log(`[zoho-pb] click-to-dial received — org=${orgId} agent=${agentId} to=${to} zohouser=${zohoUser}`);

  const publicBaseUrl = getPublicBaseUrl();
  const session = agentId && agentSessions.get(agentId);
  const respond = (status, payload) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  // Tell Zoho *why* a dial never happened, then answer the request itself.
  //
  // An HTTP error alone leaves Zoho's call bar up for a call that will never
  // exist, with nothing said to the user. clicktodialerror is what takes it
  // down. It needs a connected org to authenticate against, so the two failures
  // that precede having one — no org, or an org we hold no token for — can only
  // be answered with the HTTP error.
  const failWith = async (code, status, payload, from) => {
    if (orgId && zohoPhoneBridge.getOrg(orgId)) {
      await zohoPhoneBridge.notifyClickToDialError({
        orgId,
        from: from || VOBIZ_FROM_NUMBER || "",
        to: to || "",
        code,
        credentials: pbCredentials(),
      }).catch(err => console.error("[zoho-pb] clicktodialerror notify failed:", err.message));
    }
    return respond(status, payload);
  };

  if (!to) return respond(400, { status: "error", message: "no 'tonumber' in the request" });
  if (!orgId || !zohoPhoneBridge.getOrg(orgId)) {
    return respond(400, { status: "error", message: `unknown or unconnected orgId '${orgId}'` });
  }
  if (!agentId || !getAgent(agentId)) {
    return failWith("UNKNOWN_AGENT", 400, { status: "error", message: `unknown agentId '${agentId}'` });
  }
  // Fall back to the account-level credentials when no agent has logged in
  // through the softphone.
  //
  // Agent sessions live only in memory, so every backend restart — a redeploy,
  // or this host's idle spin-down — silently logs everyone out. Zoho's
  // click-to-dial has no way to prompt for a login, so the first call after any
  // restart would fail with a 409 that looks, from Zoho's side, like the
  // integration is broken. Falling back to the account credentials makes
  // click-to-dial work from a cold start, which is what a server-to-server
  // integration should do.
  //
  // A logged-in session still wins, so per-agent numbers keep working.
  const effectiveSession = session || (VOBIZ_AUTH_ID && VOBIZ_AUTH_TOKEN
    ? { authId: VOBIZ_AUTH_ID, authToken: VOBIZ_AUTH_TOKEN, from: VOBIZ_FROM_NUMBER }
    : null);

  if (!effectiveSession) {
    return failWith("NO_CREDENTIALS", 409, {
      status: "error",
      message: `agent '${agentId}' is not logged in, and no account-level VoBiz credentials are configured`,
      hint: "Either log in on the agent softphone, or set VOBIZ_AUTH_ID and VOBIZ_AUTH_TOKEN in the environment.",
    });
  }
  if (!effectiveSession.from) {
    return failWith("NO_CALLER_ID", 409, {
      status: "error",
      message: "no outgoing number available",
      hint: "Select a number on the agent softphone, or set VOBIZ_FROM_NUMBER in the environment.",
    });
  }
  if (!session) {
    console.log(`[zoho-pb] no agent session for '${agentId}' — using account-level credentials, calling from ${effectiveSession.from}`);
  }
  if (!publicBaseUrl) {
    return failWith("NOT_CONFIGURED", 500, { status: "error", message: "PUBLIC_BASE_URL not set" },
      effectiveSession.from);
  }

  // Agent-first, when the agent's softphone is actually open.
  //
  // Zoho's PhoneBridge specification wants the agent leg up before the customer
  // is dialled (ISSUES.md #3), and it is also the only direction that works:
  // routing into a registered WebRTC endpoint with <Dial><User> is dropped
  // platform-side. So rather than REST-dialling the customer here, hand the
  // number to the browser over the SSE stream it already holds open and let it
  // place the INVITE. /answer then bridges the customer outward.
  //
  // With no softphone listening there is nothing to dial from, so this falls
  // through to the old customer-first path — which still reaches the agent when
  // they have a phoneNumber in agents.json.
  if (BROWSER_FIRST_DIAL && hasAgentListener(agentId)) {
    const callId = `vobiz-browser-${crypto.randomUUID()}`;
    pendingBrowserCalls.set(agentId, {
      orgId, callId, agentId, zohoUser, type: "dialed",
      from: effectiveSession.from, to, createdAtMs: Date.now(),
    });
    pushAgentEvent(agentId, { type: "dial", to, callId });
    console.log(`[zoho-pb] handed ${to} to agent "${agentId}"'s softphone (callId ${callId})`);

    zohoPhoneBridge.notifyCall({
      orgId, type: "dialed", state: "ringing", callId,
      from: effectiveSession.from, to, zohoUser, credentials: pbCredentials(),
    }).catch(err => console.error("[zoho-pb] ringing notify failed:", err.message));

    return respond(200, { status: "success", callId, dialedBy: "softphone" });
  }

  const { status, json } = await placeVobizCall({
    to, agentId, session: effectiveSession, platform: "zoho-phonebridge", publicBaseUrl,
  });

  if (!json.request_uuid) {
    console.warn("[zoho-pb] VoBiz did not return a request_uuid", json);
    return failWith("CALL_REJECTED", status >= 400 ? status : 502,
      { status: "error", message: "VoBiz rejected the call", details: json },
      effectiveSession.from);
  }

  // One id for the whole life of this call. Zoho keys its UI off this, so it
  // must NOT change between ringing/answered/ended.
  const callId = `vobiz-${json.request_uuid}`;
  // effectiveSession, NOT session: `session` is undefined whenever no agent has
  // logged in on the softphone, which is the normal state for a server-to-server
  // click-to-dial and the exact case the account-credential fallback above
  // exists to serve. Reading `session.from` here threw a TypeError *after* the
  // customer's phone had already been dialled, so Zoho got a 500 for a call
  // that was really happening and no call state or call log was ever reported.
  zohoPhoneBridge.trackCall(json.request_uuid, {
    orgId, callId, agentId, zohoUser,
    type: "dialed",
    from: effectiveSession.from,
    to,
    startedAtMs: Date.now(),
  });

  // Fire-and-forget: Zoho's UI wants this promptly, but the call must not be
  // held up if Zoho is slow to acknowledge.
  zohoPhoneBridge.notifyCall({
    orgId, type: "dialed", state: "ringing", callId,
    from: effectiveSession.from, to, zohoUser, credentials: pbCredentials(),
  }).catch(err => console.error("[zoho-pb] ringing notify failed:", err.message));

  respond(200, { status: "success", code: "SUCCESS", callid: callId, vobizCallUuid: json.request_uuid });
}

/**
 * The billed duration of a finished call, straight from VoBiz's CDR.
 *
 * Everything else available at finalize time is an approximation, and a live
 * call on 16 Sep showed how far off: we reported 2 seconds for a call the CDR
 * billed at 4. `RecordingDuration` counts recorded audio, which starts after
 * the answer and is not the same thing as talk time, and the wall clock from
 * our own `answered` webhook to the recording callback drifts the other way.
 * The CDR is what the customer is billed for, so it is what belongs on the
 * Zoho record. Settles within a moment of hangup; null if it is not ready, and
 * the caller falls back.
 */
async function fetchVobizBilledDuration(vobizCallUuid, agentId) {
  const session = agentId && agentSessions.get(agentId);
  const creds = session || (VOBIZ_AUTH_ID && VOBIZ_AUTH_TOKEN
    ? { authId: VOBIZ_AUTH_ID, authToken: VOBIZ_AUTH_TOKEN }
    : null);
  if (!creds) return null;
  try {
    const res = await fetch(
      `https://api.vobiz.ai/api/v1/Account/${creds.authId}/Call/${encodeURIComponent(vobizCallUuid)}/`,
      { headers: vobizAuthHeaders(creds.authId, creds.authToken), signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return null;
    const cdr = await res.json();
    const billed = Number(cdr.bill_duration);
    return Number.isFinite(billed) && billed >= 0 ? billed : null;
  } catch (err) {
    console.warn(`[zoho-pb] could not read the CDR for ${vobizCallUuid}: ${err.message}`);
    return null;
  }
}

/**
 * Sends the single `ended` notification that closes a call out in Zoho and
 * doubles as its call log — `ended` is the only callnotify state that carries
 * duration and `voiceuri`, so there is exactly one of these per call.
 *
 * Idempotent by construction: it untracks the call first and bails if there
 * was nothing to untrack. Two things race to call it — the recording webhook
 * (the good path, with audio attached) and a fallback timer armed at
 * dial-result (for calls that produce no recording at all, e.g. no answer).
 * Whichever arrives first wins; the loser is a no-op.
 */
async function finalizeZohoPhoneBridgeCall(vobizCallUuid, { recordingId, agentId, durationSec } = {}) {
  if (!vobizCallUuid) return;
  const tracked = zohoPhoneBridge.untrackCall(vobizCallUuid);
  if (!tracked) return; // already finalized

  const endedAt = Date.now();
  // Bill from answer where we saw one, else from dial — matching how the
  // call would be counted on the customer's side.
  const startMs = tracked.answeredAtMs || tracked.startedAtMs;
  const answered = Boolean(tracked.answeredAtMs);
  // A call nobody picked up has no talk time. Without this it was logged with
  // however long the agent leg rang, which reads on the Zoho record as a real
  // conversation that never happened.
  //
  // For a call that WAS answered, prefer VoBiz's own billed duration over both
  // the recording length and our wall clock — see fetchVobizBilledDuration.
  let duration = 0;
  if (answered) {
    const billed = await fetchVobizBilledDuration(vobizCallUuid, agentId || tracked.agentId);
    duration = billed != null
      ? billed
      : durationSec != null ? durationSec : Math.round((endedAt - startMs) / 1000);
  }

  let voiceUri = null;
  const publicBaseUrl = getPublicBaseUrl();
  if (recordingId && publicBaseUrl) {
    voiceUri = buildSignedRecordingUrl(agentId || tracked.agentId, recordingId, publicBaseUrl);
  }

  // A call the agent never picked up is conceptually "missed", and Zoho
  // documents that state — but their LIVE API answers 400 to every terminal
  // state except `ended` (ISSUES.md #4, re-probed 15 Sep 2026). Sending
  // `missed` therefore did not merely lose the distinction, it lost the call
  // log entirely: the notify failed and nothing was ever written to the Zoho
  // record. So an unanswered call is reported as `ended` with duration 0,
  // which is what Zoho accepts. Set ZOHO_PB_SEND_MISSED_STATE=true to send the
  // real state once Zoho starts taking it.
  const state = answered || !ZOHO_PB_SEND_MISSED_STATE ? "ended" : "missed";

  await zohoPhoneBridge.notifyCall({
    orgId: tracked.orgId,
    type: tracked.type,
    state,
    callId: tracked.callId,
    from: tracked.from,
    to: tracked.to,
    startedAtMs: startMs,
    durationSec: duration,
    voiceUri,
    zohoUser: tracked.zohoUser,
    credentials: pbCredentials(),
  });

  console.log(
    `[zoho-pb] finalized ${tracked.callId} as ${state}${answered ? "" : " (unanswered)"} — ${duration}s` +
    (voiceUri ? " with recording" : " (no recording)"),
  );
}

/**
 * Diagnostic passthrough to Zoho's PhoneBridge API, for working out why a
 * call is rejected when Zoho's own UI says the integration is installed.
 *
 * Exists only when ZOHO_PB_DEBUG_SECRET is set, and every request must carry
 * that secret. It is deliberately NOT a general proxy: paths are confined to
 * phonebridge/v3, so it cannot be turned into a way to drive the rest of a
 * customer's Zoho account with their token. Unset the variable to remove the
 * route entirely once the question is answered.
 */
async function handleZohoPbDebug(req, res) {
  const body = await readJsonBody(req).catch(() => ({}));
  const secret = process.env.ZOHO_PB_DEBUG_SECRET;

  if (!secret || body.secret !== secret) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }

  const { orgId, path: apiPath, method = "GET", form = {} } = body;
  const org = orgId && zohoPhoneBridge.getOrg(orgId);
  if (!org) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `unknown orgId '${orgId}'` }));
    return;
  }
  // Confine to PhoneBridge. No traversal, no other Zoho services.
  const safePath = String(apiPath || "").replace(/^\/+/, "");
  if (!/^[a-z0-9/_-]+$/i.test(safePath) || safePath.includes("..")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "path must be a simple phonebridge/v3 sub-path" }));
    return;
  }

  const accessToken = await zohoPhoneBridge.getAccessToken(orgId, pbCredentials());
  const url = `${org.apiDomain}/phonebridge/v3/${safePath}`;
  const init = {
    method,
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  };
  if (method !== "GET") {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  }

  const zohoRes = await fetch(url, init);
  const text = await zohoRes.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 2000) }; }

  console.log(`[zoho-pb][debug] ${method} ${url} -> ${zohoRes.status}`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ requested: { method, url, form }, status: zohoRes.status, body: parsed }, null, 2));
}

async function handleZohoPbStatus(req, res) {
  let datacentres = null;
  let serverInfoError = null;
  try {
    datacentres = Object.keys(await zohoPhoneBridge.resolveServerInfo());
  } catch (err) {
    serverInfoError = err.message;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    configured: Boolean(PB_CLIENT_ID && PB_CLIENT_SECRET && PB_REDIRECT_URI),
    usingFallbackTestCredentials: !ZOHO_PB_CLIENT_ID,
    redirectUri: PB_REDIRECT_URI || null,
    publicBaseUrl: getPublicBaseUrl(),
    scopes: zohoPhoneBridge.PHONEBRIDGE_SCOPES,
    datacentres,
    serverInfoError,
    connectedOrgs: zohoPhoneBridge.listOrgs(),
    activeCalls: zohoPhoneBridge.listActiveCalls(),
  }, null, 2));
}

function handleHubspotConnect(req, res) {
  const authUrl = new URL("https://app.hubspot.com/oauth/authorize");
  authUrl.searchParams.set("client_id", HUBSPOT_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", HUBSPOT_REDIRECT_URI);
  authUrl.searchParams.set("scope", HUBSPOT_SCOPES);
  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
}

async function handleHubspotCallback(req, res, url) {
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("HubSpot login failed or was declined: no code returned");
    return;
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: HUBSPOT_CLIENT_ID,
    client_secret: HUBSPOT_CLIENT_SECRET,
    redirect_uri: HUBSPOT_REDIRECT_URI,
    code,
  });

  const tokenRes = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const tokenJson = await tokenRes.json();
  console.log("[backend] HubSpot token exchange response:", tokenRes.status, tokenJson);

  if (!tokenJson.access_token) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "token exchange failed", details: tokenJson }));
    return;
  }

  fs.writeFileSync(HUBSPOT_TOKENS_FILE, JSON.stringify(tokenJson, null, 2));

  const whoamiRes = await fetch(
    `https://api.hubapi.com/oauth/v1/access-tokens/${tokenJson.access_token}`,
  );
  const whoamiJson = await whoamiRes.json();
  console.log("[backend] HubSpot token info:", whoamiRes.status, whoamiJson);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    message: "Connected to HubSpot successfully",
    tokenSaved: HUBSPOT_TOKENS_FILE,
    tokenInfo: whoamiJson,
  }, null, 2));
}

function handleSalesforceConnect(req, res) {
  const authUrl = new URL(`${SALESFORCE_LOGIN_URL}/services/oauth2/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", SALESFORCE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", SALESFORCE_REDIRECT_URI);
  res.writeHead(302, { Location: authUrl.toString() });
  res.end();
}

async function handleSalesforceCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error || !code) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end(`Salesforce login failed or was declined: ${error || "no code returned"}`);
    return;
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: SALESFORCE_CLIENT_ID,
    client_secret: SALESFORCE_CLIENT_SECRET,
    redirect_uri: SALESFORCE_REDIRECT_URI,
    code,
  });

  const tokenRes = await fetch(`${SALESFORCE_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const tokenJson = await tokenRes.json();
  console.log("[backend] Salesforce token exchange response:", tokenRes.status, tokenJson);

  if (!tokenJson.access_token) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "token exchange failed", details: tokenJson }));
    return;
  }

  // Salesforce token responses don't include expires_in — instance_url (the
  // org-specific API host) is what we actually need for every later call.
  fs.writeFileSync(SALESFORCE_TOKENS_FILE, JSON.stringify(tokenJson, null, 2));

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    message: "Connected to Salesforce successfully",
    tokenSaved: SALESFORCE_TOKENS_FILE,
    instanceUrl: tokenJson.instance_url,
  }, null, 2));
}

const server = http.createServer(async (req, res) => {
  withCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/start-call" && req.method === "POST") {
    handleStartCall(req, res).catch(err => {
      console.error("[backend] /start-call error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url.pathname === "/answer") {
    handleAnswer(req, res, url).catch(err => {
      console.error("[backend] /answer error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url.pathname === "/login" && req.method === "POST") {
    handleLogin(req, res).catch(err => {
      console.error("[backend] /login error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url.pathname === "/select-number" && req.method === "POST") {
    handleSelectNumber(req, res).catch(err => {
      console.error("[backend] /select-number error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url.pathname.startsWith("/session/") && req.method === "GET") {
    const agentId = decodeURIComponent(url.pathname.slice("/session/".length));
    handleSession(req, res, agentId);
    return;
  }

  if (url.pathname === "/gather-response" && req.method === "POST") {
    handleGatherResponse(req, res, url).catch(err => {
      console.error("[backend] /gather-response error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url.pathname === "/dial-result" && req.method === "POST") {
    handleDialResult(req, res, url).catch(err => {
      console.error("[backend] /dial-result error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url.pathname === "/transcription-ready" && req.method === "POST") {
    handleTranscriptionReady(req, res, url).catch(err => {
      console.error("[backend] /transcription-ready error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url.pathname.startsWith("/call-events/") && req.method === "GET") {
    const agentId = decodeURIComponent(url.pathname.slice("/call-events/".length));
    handleCallEvents(req, res, agentId);
    return;
  }

  if (url.pathname.startsWith("/call-status/") && req.method === "GET") {
    const callUuid = decodeURIComponent(url.pathname.slice("/call-status/".length));
    const agentId = url.searchParams.get("agentId");
    handleCallStatus(req, res, callUuid, agentId).catch(err => {
      console.error("[backend] /call-status error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url.pathname === "/recording-ready" && req.method === "POST") {
    handleRecordingReady(req, res, url).catch(err => {
      console.error("[backend] /recording-ready error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url.pathname === "/inbound-answer") {
    handleInboundAnswer(req, res, url).catch(err => {
      console.error("[backend] /inbound-answer error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url.pathname === "/setup-inbound" && req.method === "POST") {
    handleSetupInbound(req, res).catch(err => {
      console.error("[backend] /setup-inbound error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url.pathname.startsWith("/cdrs/") && req.method === "GET") {
    const agentId = decodeURIComponent(url.pathname.slice("/cdrs/".length));
    handleListCdrs(req, res, agentId, url).catch(err => {
      console.error("[backend] /cdrs error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url.pathname.startsWith("/recordings/") && req.method === "GET") {
    const agentId = decodeURIComponent(url.pathname.slice("/recordings/".length));
    handleListRecordings(req, res, agentId, url).catch(err => {
      console.error("[backend] /recordings error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url.pathname.startsWith("/recording-audio/") && req.method === "GET") {
    const rest = url.pathname.slice("/recording-audio/".length); // "<agentId>/<recordingId>"
    const slashIndex = rest.indexOf("/");
    const agentId = decodeURIComponent(slashIndex === -1 ? "" : rest.slice(0, slashIndex));
    const recordingId = decodeURIComponent(slashIndex === -1 ? "" : rest.slice(slashIndex + 1));
    handleRecordingAudio(req, res, agentId, recordingId).catch(err => {
      console.error("[backend] /recording-audio error:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("error streaming recording");
    });
    return;
  }

  if (url.pathname.startsWith("/agent/") && req.method === "GET") {
    const agentId = decodeURIComponent(url.pathname.slice("/agent/".length));
    const agent = getAgent(agentId);
    if (!agent) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `unknown agentId '${agentId}'` }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(agent));
    return;
  }

  // --- Zoho PhoneBridge V3 ---
  // Matched BEFORE /zoho/connect etc. so the more specific PhoneBridge paths
  // are never shadowed by the older single-org Zoho routes.
  if (url.pathname === "/zoho/phonebridge/connect" && req.method === "GET") {
    handleZohoPbConnect(req, res, url).catch(err => {
      console.error("[backend] /zoho/phonebridge/connect error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    });
    return;
  }

  // Alias for the path Zoho registered against VoBiz's PhoneBridge partner
  // application: https://integrations.vobiz.ai/oauth/zoho/callback
  //
  // Serving it here means that once integrations.vobiz.ai points at this
  // backend, the registered redirect URI works unchanged — no need to ask
  // Zoho's partner team to re-register it, which would be a round trip of
  // days. Same handler, so both paths behave identically.
  if ((url.pathname === "/zoho/phonebridge/callback" || url.pathname === "/oauth/zoho/callback")
      && req.method === "GET") {
    handleZohoPbCallback(req, res, url).catch(err => {
      console.error("[backend] /zoho/phonebridge/callback error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    });
    return;
  }

  if (url.pathname === "/zoho/phonebridge/complete" && req.method === "GET") {
    handleZohoPbCompleteForm(req, res);
    return;
  }

  if (url.pathname === "/zoho/phonebridge/complete" && req.method === "POST") {
    handleZohoPbComplete(req, res).catch(err => {
      console.error("[backend] /zoho/phonebridge/complete error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    });
    return;
  }

  if (url.pathname === "/zoho/phonebridge/register" && req.method === "POST") {
    handleZohoPbRegister(req, res).catch(err => {
      console.error("[backend] /zoho/phonebridge/register error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    });
    return;
  }

  // Zoho calls this one. Accept GET too — it is trivial to exercise by hand
  // that way, and Zoho's own docs are not explicit about the method.
  if (url.pathname === "/zoho/phonebridge/clicktodial" && (req.method === "POST" || req.method === "GET")) {
    handleZohoPbClickToDial(req, res, url).catch(err => {
      console.error("[backend] /zoho/phonebridge/clicktodial error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "error", message: String(err.message || err) }));
    });
    return;
  }

  if (url.pathname === "/zoho/phonebridge/recording" && req.method === "GET") {
    handleZohoPbRecording(req, res, url).catch(err => {
      console.error("[backend] /zoho/phonebridge/recording error:", err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("error streaming recording");
    });
    return;
  }

  if (url.pathname === "/zoho/phonebridge/debug" && req.method === "POST") {
    handleZohoPbDebug(req, res).catch(err => {
      console.error("[backend] /zoho/phonebridge/debug error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    });
    return;
  }

  if (url.pathname === "/zoho/phonebridge/status" && req.method === "GET") {
    handleZohoPbStatus(req, res).catch(err => {
      console.error("[backend] /zoho/phonebridge/status error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    });
    return;
  }

  if (url.pathname === "/zoho/connect" && req.method === "GET") {
    handleZohoConnect(req, res);
    return;
  }

  if (url.pathname === "/zoho/callback" && req.method === "GET") {
    handleZohoCallback(req, res, url).catch(err => {
      console.error("[backend] /zoho/callback error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url.pathname === "/hubspot/connect" && req.method === "GET") {
    handleHubspotConnect(req, res);
    return;
  }

  if (url.pathname === "/hubspot/callback" && req.method === "GET") {
    handleHubspotCallback(req, res, url).catch(err => {
      console.error("[backend] /hubspot/callback error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url.pathname === "/salesforce/connect" && req.method === "GET") {
    handleSalesforceConnect(req, res);
    return;
  }

  if (url.pathname === "/salesforce/callback" && req.method === "GET") {
    handleSalesforceCallback(req, res, url).catch(err => {
      console.error("[backend] /salesforce/callback error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  // The agent softphone, and the JsSIP bundle it loads. Served from here so the
  // page shares an origin with the backend — no CORS, and the SSE click-to-dial
  // stream just works. Zoho never opens this page; the agent keeps it open in a
  // tab and Zoho's own call bar drives it over /call-events.
  if (req.method === "GET" && (url.pathname === "/agent-phone" || url.pathname === "/agent-phone.html"
      || url.pathname === "/jssip.min.js")) {
    const file = url.pathname === "/jssip.min.js" ? "jssip.min.js" : "agent-phone.html";
    const full = require("path").join(__dirname, "public", file);
    fs.readFile(full, (err, buf) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end(`missing ${file} — expected at backend/public/${file}`);
      }
      res.writeHead(200, {
        "Content-Type": file.endsWith(".js") ? "application/javascript" : "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(buf);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

// Only take the port when this file is the program. Required as a module — by
// the test suite — it hands back the same request handler without binding
// anything, so the routes can be driven end to end instead of only the
// PhoneBridge module underneath them.
if (require.main === module) startServer();

function startServer() {
server.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`);
  console.log(`[backend] tunnel URL (live): ${getPublicBaseUrl() || "(not up yet — run tunnel.js)"}`);

  // Restore the Zoho connection from config. Without this, every restart on a
  // host with an ephemeral filesystem silently drops the org and click-to-dial
  // starts failing with "no org connected" — which looks like a bug rather
  // than lost state.
  if (process.env.ZOHO_PB_REFRESH_TOKEN && process.env.ZOHO_PB_ORG_LOCATION) {
    zohoPhoneBridge.bootstrapOrgFromEnv({
      refreshToken: process.env.ZOHO_PB_REFRESH_TOKEN,
      location: process.env.ZOHO_PB_ORG_LOCATION,
      clientId: PB_CLIENT_ID,
      clientSecret: PB_CLIENT_SECRET,
    }).catch(err => console.error("[zoho-pb] could not restore org from env:", err.message));
  }
});
}

module.exports = { server, agentSessions, startServer, finalizeZohoPhoneBridgeCall };
