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
 *   agent    /agent/me, /call-events            vz_agent cookie
 *   admin    /zoho/phonebridge/{connect,complete,register,disconnect,status,debug},
 *            /admin/agent-links                  ADMIN_TOKEN
 *   Zoho     /zoho/phonebridge/clicktodial        HMAC token in the registered URI
 *            /zoho/phonebridge/callback           signed OAuth state
 *            /zoho/phonebridge/recording          HMAC-signed, expiring link
 *   Vobiz    /answer, /inbound-answer, /dial-event, /dial-result, /recording-ready
 *                                                 X-Vobiz-Signature-V3
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

const {
  VOBIZ_AUTH_ID,
  VOBIZ_AUTH_TOKEN,
  VOBIZ_FROM_NUMBER,
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

// With no softphone open, click-to-dial is refused and Zoho is told why. Set to
// `phone` to ring the agent's `phoneNumber` from agents.json instead.
const CLICKTODIAL_WHEN_OFFLINE = process.env.CLICKTODIAL_WHEN_OFFLINE || "refuse";

const MAX_BODY_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Agent event stream
// ---------------------------------------------------------------------------

const callEventListeners = new Map(); // agentId -> Set<res>

// Click-to-dial calls handed to a softphone, waiting for Vobiz to tell us the
// CallUUID. Zoho needs one stable callId for the whole call, so the id is
// minted at click time and bound to the real UUID when /answer fires.
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

/** "sip:priya123@registrar.vobiz.ai" -> the agent whose sipUser has that username. */
function agentIdForSipFrom(from) {
  const m = String(from || "").match(/^sips?:([^@;>]+)@/i);
  if (!m) return null;
  const user = m[1].toLowerCase();
  const hit = Object.entries(loadAgents()).find(([, a]) =>
    a && a.sipUser && String(a.sipUser).replace(/^sips?:/i, "").split("@")[0].toLowerCase() === user);
  return hit ? hit[0] : null;
}

const callerIdFor = agent => (agent && agent.callerId) || VOBIZ_FROM_NUMBER || "";

// ---------------------------------------------------------------------------
// Vobiz webhook signature
// ---------------------------------------------------------------------------

/**
 * X-Vobiz-Signature-V3 = base64(HMAC-SHA256(authToken, url + "." + nonce)),
 * V2 the same without the ".". The URL is the one Vobiz was handed, without
 * its query string — rebuilt from PUBLIC_BASE_URL, since behind a tunnel the
 * Host header is not what Vobiz addressed. The body is never covered.
 */
function verifyVobizSignature(req, url) {
  const v3 = req.headers["x-vobiz-signature-v3"];
  const v2 = req.headers["x-vobiz-signature-v2"];
  const nonce = req.headers["x-vobiz-signature-v3-nonce"] || req.headers["x-vobiz-signature-v2-nonce"];
  const base = getPublicBaseUrl();
  if (!VOBIZ_AUTH_TOKEN || !base || !nonce || !(v3 || v2)) return false;
  const signed = `${base}${url.pathname}`;
  const expected = v3
    ? crypto.createHmac("sha256", VOBIZ_AUTH_TOKEN).update(`${signed}.${nonce}`).digest("base64")
    : crypto.createHmac("sha256", VOBIZ_AUTH_TOKEN).update(`${signed}${nonce}`).digest("base64");
  const a = Buffer.from(String(v3 || v2));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Default: verify and warn. REQUIRE_VOBIZ_SIGNATURE=true refuses unsigned or
 * mis-signed webhooks — turn it on once the logs show "signature ok" on a real
 * call through your PUBLIC_BASE_URL.
 */
function vobizWebhookAllowed(req, url) {
  if (verifyVobizSignature(req, url)) {
    console.log(`[backend] ${url.pathname} signature ok`);
    return true;
  }
  if (process.env.REQUIRE_VOBIZ_SIGNATURE === "true") {
    console.warn(`[backend] ${url.pathname} signature missing or wrong — refused (REQUIRE_VOBIZ_SIGNATURE=true)`);
    return false;
  }
  console.warn(`[backend] ${url.pathname} signature missing or wrong — accepted (set REQUIRE_VOBIZ_SIGNATURE=true to refuse)`);
  return true;
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
function vobizXmlDialCustomer(to, callerId, agentId, publicBaseUrl) {
  const qs = `agentId=${encodeURIComponent(agentId)}`;
  const callerIdAttr = callerId ? ` callerId="${escapeXml(callerId)}"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record recordSession="true" redirect="false" playBeep="false" fileFormat="mp3"
    callbackUrl="${publicBaseUrl}/recording-ready?${qs}" callbackMethod="POST"/>
  <Dial${callerIdAttr} timeout="30" timeLimit="14400" redirect="false" method="POST"
    action="${publicBaseUrl}/dial-result?${qs}"
    callbackUrl="${publicBaseUrl}/dial-event?${qs}" callbackMethod="POST">
    <Number>${escapeXml(String(to).replace(/^\+/, ""))}</Number>
  </Dial>
  <Hangup/>
</Response>`;
}

/**
 * Offline fallback (CLICKTODIAL_WHEN_OFFLINE=phone): the customer was dialled
 * over the REST API and has answered; ring the agent's own phone. PSTN only —
 * <Dial><User> into a browser is deliberately not attempted.
 */
function vobizXmlDialAgentPhone(agent, agentId, publicBaseUrl, callerId) {
  const qs = `agentId=${encodeURIComponent(agentId)}`;
  const callerIdAttr = callerId ? ` callerId="${escapeXml(callerId)}"` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record recordSession="true" redirect="false" playBeep="false" fileFormat="mp3"
    callbackUrl="${publicBaseUrl}/recording-ready?${qs}" callbackMethod="POST"/>
  <Dial${callerIdAttr} timeout="30" redirect="false" method="POST"
    action="${publicBaseUrl}/dial-result?${qs}">
    <Number>${escapeXml(agent.phoneNumber)}</Number>
  </Dial>
  <Speak>The agent could not be reached. Goodbye.</Speak>
  <Hangup/>
</Response>`;
}

/**
 * A customer called the Vobiz number. Rings the agent's browser (and their
 * phone, when agents.json gives one) with callerId set to the DID that was
 * dialled — without it Vobiz derives the B leg's caller ID from the caller's
 * own number, which the account does not own, and never creates the B leg.
 */
function vobizXmlInboundToAgent(agent, agentId, publicBaseUrl, dialedNumber) {
  const qs = `agentId=${encodeURIComponent(agentId)}&dir=in`;
  const callerIdAttr = dialedNumber ? ` callerId="${escapeXml(toE164(dialedNumber))}"` : "";
  const destinations = [`    <User>sip:${escapeXml(String(agent.sipUser).replace(/^sips?:/i, ""))}</User>`];
  if (agent.phoneNumber) destinations.push(`    <Number>${escapeXml(agent.phoneNumber)}</Number>`);
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

const vobizHeaders = () => ({ "X-Auth-ID": VOBIZ_AUTH_ID, "X-Auth-Token": VOBIZ_AUTH_TOKEN });

/** Customer-first call, used only by the offline `phone` fallback. */
async function placeVobizCall({ to, from, agentId, publicBaseUrl }) {
  const params = new URLSearchParams({
    to,
    from,
    answer_url: `${publicBaseUrl}/answer?agentId=${encodeURIComponent(agentId)}`,
    answer_method: "POST",
  });
  const res = await fetch(`https://api.vobiz.ai/api/v1/Account/${encodeURIComponent(VOBIZ_AUTH_ID)}/Call/`, {
    method: "POST",
    headers: { ...vobizHeaders(), "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const json = await res.json().catch(() => ({}));
  console.log("[backend] Vobiz Call API response:", res.status, json.request_uuid || json.error || "");
  return { status: res.status, json };
}

/**
 * Billed duration from the CDR. For a browser-originated call the browser's
 * own leg is billed from before the customer even rang, so the B leg — the
 * customer, or the agent on an inbound call — is what is asked for.
 */
async function fetchVobizBilledDuration(callUuid) {
  if (!VOBIZ_AUTH_ID || !VOBIZ_AUTH_TOKEN || !callUuid) return null;
  try {
    const res = await fetch(
      `https://api.vobiz.ai/api/v1/Account/${encodeURIComponent(VOBIZ_AUTH_ID)}/Call/${encodeURIComponent(callUuid)}/`,
      { headers: vobizHeaders(), signal: AbortSignal.timeout(5000) },
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
 * Streams a recording, fetched server-side on the account credentials. Only
 * reachable through the HMAC-signed /zoho/phonebridge/recording link; takes a
 * recording id, never a URL.
 */
async function streamRecording(res, recordingId) {
  if (!VOBIZ_AUTH_ID || !VOBIZ_AUTH_TOKEN) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    return res.end("recording playback is not configured");
  }
  const metaRes = await fetch(
    `https://api.vobiz.ai/api/v1/Account/${encodeURIComponent(VOBIZ_AUTH_ID)}/Recording/${encodeURIComponent(recordingId)}/`,
    { headers: vobizHeaders() },
  );
  if (!metaRes.ok) {
    res.writeHead(metaRes.status === 404 ? 404 : 502, { "Content-Type": "text/plain" });
    return res.end("recording not found");
  }
  const meta = await metaRes.json();
  const fileUrl = meta.recording_url;
  // The file must come from Vobiz — never follow a URL to anywhere else with
  // the account credentials attached.
  let host = "";
  try { host = new URL(fileUrl).hostname; } catch { /* fall through */ }
  if (!host || !(host === "vobiz.ai" || host.endsWith(".vobiz.ai"))) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("no recording file yet");
  }
  const fileRes = await fetch(fileUrl, { headers: vobizHeaders() });
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

async function handleAnswer(req, res, url) {
  const body = await readBody(req).catch(() => ({}));
  if (!vobizWebhookAllowed(req, url)) return sendXml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);

  // Vobiz posts the end-of-call notification here when no hangup_url is set.
  // Acknowledge it; never answer it with call instructions.
  if ((body.Event || "") === "Hangup") return sendXml(res, EMPTY_XML);

  const from = String(body.From || body.from || "");
  const routeType = String(body.RouteType || body.routetype || "").toLowerCase();
  const browserLeg = from.startsWith("sip:") || routeType === "sip";

  // The agent comes from ?agentId= on the answer URL, or — for a call the
  // softphone placed — from the SIP username it called from, so the endpoint's
  // application does not need a per-agent answer URL.
  const agentId = url.searchParams.get("agentId") || (browserLeg ? agentIdForSipFrom(from) : null);
  const agent = getAgent(agentId);
  const publicBaseUrl = getPublicBaseUrl();
  if (!agent || !publicBaseUrl) {
    console.warn(`[backend] /answer — no agent for agentId=${agentId} from=${from}; check agents.json and the endpoint's application`);
    return sendXml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Speak>This call cannot be connected right now.</Speak><Hangup/></Response>`);
  }
  const callUuid = body.CallUUID || body.call_uuid || body.RequestUUID;

  if (browserLeg) {
    const customer = body.To || body.to;
    console.log(`[backend] /answer — ${agentId}'s browser is the A leg, dialling ${customer}`);
    const pending = pendingBrowserCalls.get(agentId);
    if (pending && callUuid && !zohoPhoneBridge.getTrackedCall(callUuid)) {
      pendingBrowserCalls.delete(agentId);
      zohoPhoneBridge.trackCall(callUuid, { ...pending, startedAtMs: Date.now() });
      console.log(`[zoho-pb] bound ${pending.callId} to CallUUID ${callUuid}`);
    }
    const callerId = callerIdFor(agent);
    if (!callerId) {
      // Without callerId Vobiz derives it from the A leg — here a SIP username,
      // not a number — and never creates the customer leg.
      console.warn(`[backend] /answer — no caller ID for ${agentId}; set callerId in agents.json or VOBIZ_FROM_NUMBER`);
      return sendXml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Speak>This line has no caller ID configured.</Speak><Hangup/></Response>`);
    }
    return sendXml(res, vobizXmlDialCustomer(customer, callerId, agentId, publicBaseUrl));
  }

  // Customer-first (offline `phone` fallback): this webhook IS the customer
  // answering.
  markAnswered(callUuid);
  if (!agent.phoneNumber) {
    return sendXml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Speak>The agent could not be reached. Goodbye.</Speak><Hangup/></Response>`);
  }
  return sendXml(res, vobizXmlDialAgentPhone(agent, agentId, publicBaseUrl, body.From || callerIdFor(agent)));
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

/** Dial callbackUrl: DialAnswer is the moment the B leg picked up. */
async function handleDialEvent(req, res, url) {
  const body = await readBody(req).catch(() => ({}));
  if (!vobizWebhookAllowed(req, url)) return sendXml(res, EMPTY_XML);
  const event = String(body.Event || "");
  const action = String(body.DialAction || "").toLowerCase();
  const callUuid = body.CallUUID || body.DialALegUUID;
  if (event === "DialAnswer" || action === "answer") {
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
  if (!vobizWebhookAllowed(req, url)) return sendXml(res, EMPTY_XML);
  const agentId = url.searchParams.get("agentId");
  console.log(`[backend] dial finished — DialStatus=${body.DialStatus} DialHangupCause=${body.DialHangupCause}`);
  if (agentId) pushAgentEvent(agentId, { type: "call-ended", status: body.DialStatus });

  // Safety net: the recording webhook is the preferred place to close a call
  // (it carries the audio), but a call with no recording never produces one.
  // finalize is idempotent, so whichever arrives first wins.
  const callUuid = body.CallUUID || body.DialALegUUID || body.RequestUUID;
  if (callUuid && zohoPhoneBridge.getTrackedCall(callUuid)) {
    if (body.DialBLegUUID) zohoPhoneBridge.updateTrackedCall(callUuid, { bLegUuid: body.DialBLegUUID });
    setTimeout(() => {
      finalizeZohoPhoneBridgeCall(callUuid).catch(err => console.error("[zoho-pb] fallback finalize failed:", err.message));
    }, ZOHO_PB_RECORDING_GRACE_MS).unref();
  }
  sendXml(res, EMPTY_XML);
}

async function handleRecordingReady(req, res, url) {
  const body = await readBody(req).catch(() => ({}));
  if (!vobizWebhookAllowed(req, url)) return sendJson(res, 200, { received: false });
  sendJson(res, 200, { received: true });

  // Any call Zoho is tracking — browser-originated, offline fallback or
  // inbound. Keyed on the call, not on which route placed it, which is what
  // used to drop the recording from every browser-originated call.
  const callUuid = body.CallUUID || body.ALegRequestUUID;
  if (callUuid && zohoPhoneBridge.getTrackedCall(callUuid)) {
    finalizeZohoPhoneBridgeCall(callUuid, {
      recordingId: body.RecordingID || body.recording_id,
      durationSec: Number(body.RecordingDuration || body.recording_duration || 0) || null,
    }).catch(err => console.error("[zoho-pb] final call log failed:", err.message));
  }
}

async function handleInboundAnswer(req, res, url) {
  const body = await readBody(req).catch(() => ({}));
  if (!vobizWebhookAllowed(req, url)) return sendXml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  if ((body.Event || "") === "Hangup") return sendXml(res, EMPTY_XML);

  const agentId = url.searchParams.get("agentId");
  const agent = getAgent(agentId);
  const publicBaseUrl = getPublicBaseUrl();
  if (!agent || !publicBaseUrl) {
    console.warn(`[backend] /inbound-answer misconfigured — agentId=${agentId} agentFound=${Boolean(agent)}`);
    return sendXml(res, `<?xml version="1.0" encoding="UTF-8"?><Response><Speak>This number is not configured yet.</Speak><Hangup/></Response>`);
  }
  const callUuid = body.CallUUID || body.call_uuid || null;
  const caller = toE164(body.From || body.from);
  const dialled = toE164(body.To || body.to);
  console.log(`[backend] inbound call ${caller} -> ${dialled}, ringing ${agentId}`);

  pushAgentEvent(agentId, { type: "inbound-routed", from: body.CallerName || caller || "unknown", callUuid });

  // Log the call in Zoho when this agent belongs to a connected org.
  const orgId = zohoPhoneBridge.orgForAgent(agentId);
  if (orgId && callUuid && !zohoPhoneBridge.getTrackedCall(callUuid)) {
    const org = zohoPhoneBridge.getOrg(orgId);
    const zohoUser = (org && org.agentMap && org.agentMap[agentId]) || null;
    const tracked = zohoPhoneBridge.trackCall(callUuid, {
      orgId, callId: `vobiz-in-${callUuid}`, agentId, zohoUser,
      type: "received", from: caller, to: dialled, startedAtMs: Date.now(),
    });
    zohoPhoneBridge.notifyCall({
      orgId, type: "received", state: "ringing", callId: tracked.callId,
      from: caller, to: dialled, zohoUser, credentials: pbCredentials(),
    }).catch(err => console.error("[zoho-pb] inbound ringing notify failed:", err.message));
  }

  sendXml(res, vobizXmlInboundToAgent(agent, agentId, publicBaseUrl, body.To || body.to));
}

// ---------------------------------------------------------------------------
// Zoho PhoneBridge
// ---------------------------------------------------------------------------

function signRecordingToken(agentId, recordingId, expiresAtMs) {
  return crypto.createHmac("sha256", RECORDING_URL_SECRET)
    .update(`${agentId}.${recordingId}.${expiresAtMs}`).digest("hex");
}

function buildSignedRecordingUrl(agentId, recordingId, publicBaseUrl) {
  const expiresAt = Date.now() + RECORDING_URL_TTL_MS;
  const sig = signRecordingToken(agentId, recordingId, expiresAt);
  const qs = new URLSearchParams({ agentId: agentId || "", recordingId, expires: String(expiresAt), sig });
  return `${publicBaseUrl}/zoho/phonebridge/recording?${qs.toString()}`;
}

async function handleZohoPbRecording(req, res, url) {
  const agentId = url.searchParams.get("agentId") || "";
  const recordingId = url.searchParams.get("recordingId");
  const expires = Number(url.searchParams.get("expires") || 0);
  const sig = url.searchParams.get("sig") || "";
  if (!recordingId || !expires || Date.now() > expires) {
    res.writeHead(410, { "Content-Type": "text/plain" });
    return res.end("recording link missing or expired");
  }
  const expected = signRecordingToken(agentId, recordingId, expires);
  if (!(sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("bad signature");
  }
  await streamRecording(res, recordingId);
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
  const to = fields.tonumber || fields.toNumber || fields.to;
  const org = zohoPhoneBridge.getOrg(orgId);

  // Zoho says who clicked. When that user is mapped to an agent, it wins over
  // the agent baked into the URI.
  const zohoUser = fields.zohouser || fields.zohoUser || null;
  const mappedAgent = org && agentForZohoUser(org.agentMap, zohoUser);
  const agentId = mappedAgent || uriAgentId;
  const agent = getAgent(agentId);
  const from = callerIdFor(agent);
  const effectiveZohoUser = zohoUser || (org && org.agentMap && org.agentMap[agentId]) || null;
  console.log(`[zoho-pb] click-to-dial — org=${orgId} agent=${agentId} to=${to} zohouser=${zohoUser}`);

  const failWith = async (code, status, payload) => {
    if (org) {
      await zohoPhoneBridge.notifyClickToDialError({
        orgId, from, to: to || "", code, credentials: pbCredentials(),
      }).catch(err => console.error("[zoho-pb] clicktodialerror notify failed:", err.message));
    }
    return sendJson(res, status, payload);
  };

  if (!to) return sendJson(res, 400, { status: "error", message: "no 'tonumber' in the request" });
  if (!org) return sendJson(res, 400, { status: "error", message: `unknown or unconnected orgId '${orgId}'` });
  if (!agent) return failWith("UNKNOWN_AGENT", 400, { status: "error", message: `unknown agent '${agentId}'` });
  if (!from) return failWith("NO_CALLER_ID", 409, { status: "error", message: "no caller ID — set callerId on the agent or VOBIZ_FROM_NUMBER" });
  const publicBaseUrl = getPublicBaseUrl();
  if (!publicBaseUrl) return failWith("NOT_CONFIGURED", 500, { status: "error", message: "PUBLIC_BASE_URL not set" });

  // Agent first: hand the number to the open softphone, which places the
  // INVITE; /answer then dials the customer.
  if (hasAgentListener(agentId)) {
    const callId = `vobiz-browser-${crypto.randomUUID()}`;
    pendingBrowserCalls.set(agentId, {
      orgId, callId, agentId, zohoUser: effectiveZohoUser, type: "dialed", from, to, createdAtMs: Date.now(),
    });
    pushAgentEvent(agentId, { type: "dial", to, callId });
    zohoPhoneBridge.notifyCall({
      orgId, type: "dialed", state: "ringing", callId, from, to, zohoUser: effectiveZohoUser, credentials: pbCredentials(),
    }).catch(err => console.error("[zoho-pb] ringing notify failed:", err.message));
    return sendJson(res, 200, { status: "success", code: "SUCCESS", callid: callId, dialedBy: "softphone" });
  }

  // No softphone open.
  if (CLICKTODIAL_WHEN_OFFLINE !== "phone" || !agent.phoneNumber) {
    return failWith("AGENT_OFFLINE", 409, {
      status: "error",
      message: `agent '${agentId}' has no softphone open`,
      hint: "open /agent-phone, or set CLICKTODIAL_WHEN_OFFLINE=phone and a phoneNumber on the agent",
    });
  }
  if (!VOBIZ_AUTH_ID || !VOBIZ_AUTH_TOKEN) {
    return failWith("NO_CREDENTIALS", 409, { status: "error", message: "VOBIZ_AUTH_ID / VOBIZ_AUTH_TOKEN not set" });
  }
  const { status, json } = await placeVobizCall({ to, from, agentId, publicBaseUrl });
  if (!json.request_uuid) {
    return failWith("CALL_REJECTED", status >= 400 ? status : 502, { status: "error", message: "Vobiz rejected the call", details: json });
  }
  const callId = `vobiz-${json.request_uuid}`;
  zohoPhoneBridge.trackCall(json.request_uuid, {
    orgId, callId, agentId, zohoUser: effectiveZohoUser, type: "dialed", from, to, startedAtMs: Date.now(),
  });
  zohoPhoneBridge.notifyCall({
    orgId, type: "dialed", state: "ringing", callId, from, to, zohoUser: effectiveZohoUser, credentials: pbCredentials(),
  }).catch(err => console.error("[zoho-pb] ringing notify failed:", err.message));
  sendJson(res, 200, { status: "success", code: "SUCCESS", callid: callId, dialedBy: "phone" });
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
    const billed = await fetchVobizBilledDuration(tracked.bLegUuid || callUuid);
    duration = billed != null ? billed : durationSec != null ? durationSec : Math.round((Date.now() - startMs) / 1000);
  }
  const publicBaseUrl = getPublicBaseUrl();
  const voiceUri = recordingId && publicBaseUrl ? buildSignedRecordingUrl(tracked.agentId, recordingId, publicBaseUrl) : null;
  const base = {
    orgId: tracked.orgId, type: tracked.type, callId: tracked.callId,
    from: tracked.from, to: tracked.to, startedAtMs: startMs, voiceUri,
    zohoUser: tracked.zohoUser, credentials: pbCredentials(),
  };

  if (!answered && ZOHO_PB_SEND_MISSED_STATE) {
    const missed = await zohoPhoneBridge.notifyCall({ ...base, state: "missed" });
    if (missed.ok) return;
    console.warn(`[zoho-pb] Zoho refused 'missed' for ${tracked.callId} — logging it as ended/0s instead`);
  }
  await zohoPhoneBridge.notifyCall({ ...base, state: "ended", durationSec: duration });
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

/** The signed-in agent's own SIP credentials — and nobody else's. */
function handleAgentMe(req, res, requestedId) {
  const agentId = auth.agentFromRequest(req);
  if (!agentId) return sendJson(res, 401, { error: "not signed in" });
  if (requestedId && requestedId !== "me" && requestedId !== agentId) return sendJson(res, 403, { error: "forbidden" });
  const agent = getAgent(agentId);
  if (!agent) return sendJson(res, 401, { error: "not signed in" });
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, 200, { agentId, displayName: agent.displayName || agentId, sipUser: agent.sipUser, sipPassword: agent.sipPassword });
}

function handleCallEvents(req, res, requestedId) {
  const agentId = auth.agentFromRequest(req);
  if (!agentId || (requestedId && requestedId !== agentId)) return sendJson(res, 401, { error: "not signed in" });
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
  sendJson(res, 200, { ok: true, next: "/zoho/phonebridge/connect" }, { "Set-Cookie": auth.adminCookie(req) });
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
  Promise.resolve(fn(req, res, ...args)).catch(err => {
    console.error(`[backend] ${req.method} ${req.url.split("?")[0]} failed:`, err);
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    else res.end();
  });

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
  "GET /zoho/phonebridge/connect": requireAdmin(wrap(handleZohoPbConnect)),
  "GET /zoho/phonebridge/complete": requireAdmin(handleZohoPbCompleteForm),
  "POST /zoho/phonebridge/complete": requireAdmin(wrap(handleZohoPbComplete)),
  "POST /zoho/phonebridge/register": requireAdmin(wrap(handleZohoPbRegister)),
  "POST /zoho/phonebridge/disconnect": requireAdmin(wrap(handleZohoPbDisconnect)),
  "GET /zoho/phonebridge/status": requireAdmin(wrap(handleZohoPbStatus)),
  "POST /zoho/phonebridge/debug": requireAdmin(wrap(handleZohoPbDebug)),

  // Agent
  "POST /agent-session": wrap(handleAgentSession),
  "POST /agent-logout": (req, res) => sendJson(res, 200, { ok: true }, { "Set-Cookie": auth.clearAgentCookie() }),
  "GET /call-events": (req, res) => handleCallEvents(req, res, null),
};

const server = http.createServer((req, res) => {
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

  if (req.method === "GET" && p.startsWith("/agent/")) {
    return handleAgentMe(req, res, decodeURIComponent(p.slice("/agent/".length)));
  }
  if (req.method === "GET" && p.startsWith("/call-events/")) {
    return handleCallEvents(req, res, decodeURIComponent(p.slice("/call-events/".length)));
  }

  // Static files come from a fixed whitelist — no path from the request ever
  // reaches the filesystem.
  const file = req.method === "GET" && STATIC_FILES[p];
  if (file) {
    return fs.readFile(path.join(__dirname, "public", file[0]), (err, buf) => {
      if (err) return sendJson(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-store" });
      res.end(buf);
    });
  }

  sendJson(res, 404, { error: "not found" });
});

// Only bind the port when run directly; the test suite requires the module.
if (require.main === module) startServer();

function startServer() {
  // Fail at boot, not on the first OAuth callback.
  parseKey(process.env.TOKEN_ENCRYPTION_KEY);
  if (!process.env.ADMIN_TOKEN) console.warn("[backend] ADMIN_TOKEN is not set — admin routes are disabled");
  if (!pbConfigured()) console.warn("[backend] ZOHO_PB_CLIENT_ID / _SECRET / _REDIRECT_URI not all set — Zoho connect is disabled");
  if (!getPublicBaseUrl()) console.warn("[backend] PUBLIC_BASE_URL is not set — Vobiz and Zoho cannot reach this backend");
  server.listen(Number(PORT) || 8092, () => {
    console.log(`[backend] listening on http://localhost:${Number(PORT) || 8092} — public URL ${getPublicBaseUrl() || "(unset)"}`);
  });
}

module.exports = { server, startServer, finalizeZohoPhoneBridgeCall, auth, verifyVobizSignature };
