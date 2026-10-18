"use strict";

/**
 * Any Vobiz account, signed in from the softphone.
 *
 * Nothing about a Vobiz account lives in env or in a tracked file. An agent
 * types their Auth ID and Auth Token into the softphone; this module checks the
 * pair against Vobiz and provisions what the integration needs in THAT account:
 *
 *   - one Application whose answer_url is <PUBLIC_BASE_URL>/answer — found if
 *     this backend created it before, created otherwise. An application with
 *     any other answer_url is never touched.
 *   - one SIP endpoint per (authId, agentId), bound to that application, with a
 *     fresh random SIP password on every sign-in. Only {endpointId, username}
 *     is written to disk (vobiz-endpoints.json under DATA_DIR, mode 0600).
 *
 * Second mode, "SIP direct": the agent types the SIP username and password of
 * an endpoint they already have, plus a caller-ID number. The password never
 * reaches this backend — the browser registers with it directly. The backend
 * only records sipUser -> {callerId, inbound number = callerId} so webhooks
 * can be routed. No account API is available in that mode (no recordings,
 * number list or "Enable inbound"); the customer binds the endpoint and DID to
 * an application whose answer_url is <PUBLIC_BASE_URL>/answer themselves.
 *
 * The account Auth Token stays in this process's memory, keyed by authId. It is
 * never written to disk, logged, or returned in a response. After a restart an
 * account is unknown until one of its agents signs in again.
 *
 * Vobiz app ids are 17 digits — above Number.MAX_SAFE_INTEGER. They are kept as
 * strings end to end: responses are read with long integers quoted before
 * JSON.parse, and request bodies are built as text with the id spliced in.
 * The bind follows the Vobiz WebRTC playground, which works against any
 * account: {"app_id":"<id>"} first, verified with a GET, then the documented
 * {"application":<integer>} if the first did not take.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API = "https://api.vobiz.ai/api/v1";
const APP_NAME = "Vobiz-Zoho-PhoneBridge";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Quote every bare integer of 16+ digits so JSON.parse cannot round it. */
function parseVobizJson(text) {
  if (!text) return {};
  const safe = String(text).replace(/(:\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  try {
    return JSON.parse(safe);
  } catch {
    return {};
  }
}

const isDigits = v => /^\d+$/.test(String(v || ""));
const digitsOf = v => String(v || "").replace(/\D/g, "");

class VobizAuthError extends Error {}
class VobizApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function vobiz(authId, authToken, method, pathAndQuery, rawBody) {
  const init = {
    method,
    headers: { "X-Auth-ID": authId, "X-Auth-Token": authToken },
    signal: AbortSignal.timeout(10_000),
  };
  if (rawBody !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = rawBody;
  }
  const res = await fetch(`${API}/Account/${encodeURIComponent(authId)}${pathAndQuery}`, init);
  const text = await res.text().catch(() => "");
  return { status: res.status, ok: res.ok, text, json: parseVobizJson(text) };
}

// ---------------------------------------------------------------------------
// Endpoint store: {authId:agentId -> {endpointId, username}} — no secrets
// ---------------------------------------------------------------------------

const storeFile = () => path.join(process.env.DATA_DIR || __dirname, "vobiz-endpoints.json");

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`[vobiz] could not read ${storeFile()}: ${err.message}`);
    return {};
  }
}

function writeStore(all) {
  const target = storeFile();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
}

const storeKey = (authId, agentId) => `${authId}:${agentId}`;

function getStoredEndpoint(authId, agentId) {
  const rec = readStore()[storeKey(authId, agentId)];
  return rec && rec.endpointId ? { endpointId: String(rec.endpointId), username: String(rec.username || "") } : null;
}

function putStoredEndpoint(authId, agentId, rec) {
  const all = readStore();
  all[storeKey(authId, agentId)] = { endpointId: String(rec.endpointId), username: String(rec.username) };
  writeStore(all);
}

function dropStoredEndpoint(authId, agentId) {
  const all = readStore();
  delete all[storeKey(authId, agentId)];
  writeStore(all);
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const accounts = new Map();      // authId -> { authToken, numbers: [e164], appId }
const agentSessions = new Map(); // agentId -> { mode, authId, sipUser, endpointId, callerId, inboundNumber }
const sipUsers = new Map();      // lower(sipUser) -> agentId
const lastChoice = new Map();    // authId:agentId -> last caller ID picked

function resetForTests() {
  accounts.clear();
  agentSessions.clear();
  sipUsers.clear();
  lastChoice.clear();
}

// ---------------------------------------------------------------------------
// Vobiz calls
// ---------------------------------------------------------------------------

/**
 * List Account Phone Numbers, every page — the first call doubles as the
 * credential check (non-2xx is a bad pair). Only active, voice-enabled numbers
 * can be a caller ID. application_id says which app answers each one today.
 */
async function listNumbers(authId, authToken) {
  const out = [];
  let seen = 0;
  for (let page = 1; page <= 50; page += 1) {
    const r = await vobiz(authId, authToken, "GET", `/numbers?page=${page}&per_page=100`);
    if (!r.ok) {
      if (page === 1) throw new VobizAuthError("Vobiz did not accept that Auth ID and Auth Token");
      throw new VobizApiError(`listing numbers failed on page ${page} (${r.status})`, r.status);
    }
    const items = Array.isArray(r.json.items) ? r.json.items : [];
    seen += items.length;
    for (const n of items) {
      if (!n || !n.e164 || n.status !== "active" || n.voice_enabled === false) continue;
      const e164 = String(n.e164).startsWith("+") ? String(n.e164) : `+${digitsOf(n.e164)}`;
      out.push({ e164, applicationId: n.application_id != null && n.application_id !== "" ? String(n.application_id) : null });
    }
    const total = Number(r.json.total);
    if (!items.length || !Number.isFinite(total) || seen >= total) break;
  }
  return out;
}

/** The application this backend created in this account, or a new one. */
async function findOrCreateApplication(authId, authToken, publicBaseUrl) {
  const answerUrl = `${publicBaseUrl}/answer`;
  for (let offset = 0, pages = 0; pages < 20; pages += 1, offset += 100) {
    const r = await vobiz(authId, authToken, "GET", `/Application/?limit=100&offset=${offset}`);
    if (!r.ok) throw new VobizApiError(`listing applications failed (${r.status})`, r.status);
    const objects = Array.isArray(r.json.objects) ? r.json.objects : [];
    const hit = objects.find(a => a && a.answer_url === answerUrl && isDigits(a.app_id));
    if (hit) return String(hit.app_id);
    if (!r.json.meta || !r.json.meta.next || objects.length === 0) break;
  }
  const body = JSON.stringify({
    app_name: APP_NAME,
    answer_url: answerUrl,
    answer_method: "POST",
    hangup_url: `${publicBaseUrl}/hangup`,
    hangup_method: "POST",
  });
  const r = await vobiz(authId, authToken, "POST", "/Application/", body);
  const appId = r.json.app_id != null ? String(r.json.app_id) : "";
  if (!r.ok || !isDigits(appId)) throw new VobizApiError(`creating the application failed (${r.status})`, r.status || 502);
  console.log(`[vobiz] ${authId}: created application ${appId} -> ${answerUrl}`);
  return appId;
}

const newPassword = () => crypto.randomBytes(18).toString("base64url").replace(/[^A-Za-z0-9]/g, "") + "Vz9";

const aliasFor = agentId => `zoho-${String(agentId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "agent"}`;

/** An endpoint this integration made for the agent, found by its exact alias. */
async function findEndpointByAlias(authId, authToken, agentId) {
  const alias = aliasFor(agentId);
  for (let offset = 0, pages = 0; pages < 20; pages += 1, offset += 100) {
    const r = await vobiz(authId, authToken, "GET", `/Endpoint/?limit=100&offset=${offset}`);
    if (!r.ok) return null;
    const objects = Array.isArray(r.json.objects) ? r.json.objects : [];
    const hit = objects.find(e => e && e.alias === alias && e.endpoint_id != null && e.username);
    if (hit) return { endpointId: String(hit.endpoint_id), username: String(hit.username) };
    if (!r.json.meta || !r.json.meta.next || objects.length === 0) return null;
  }
  return null;
}

function usernameFor(agentId) {
  const base = String(agentId).replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "agent";
  return `zoho${base}${crypto.randomBytes(3).toString("hex")}`;
}

async function readEndpoint(authId, authToken, endpointId) {
  const r = await vobiz(authId, authToken, "GET", `/Endpoint/${encodeURIComponent(endpointId)}/`);
  return r;
}

async function createEndpoint(authId, authToken, agentId, password) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const body = JSON.stringify({ username: usernameFor(agentId), password, alias: aliasFor(agentId) });
    const r = await vobiz(authId, authToken, "POST", "/Endpoint/", body);
    if (r.status === 409) continue;
    const endpointId = r.json.endpoint_id != null ? String(r.json.endpoint_id) : "";
    if (!r.ok || !endpointId) throw new VobizApiError(`creating the SIP endpoint failed (${r.status})`, r.status || 502);
    // Vobiz rewrites the submitted username — the stored one is the truth.
    const got = await readEndpoint(authId, authToken, endpointId);
    const username = got.ok && got.json.username ? String(got.json.username) : "";
    if (!username) throw new VobizApiError("could not read the new endpoint back", got.status || 502);
    return { endpointId, username };
  }
  throw new VobizApiError("could not find a free SIP username", 409);
}

/**
 * Bind endpoint -> application: {"app_id":"<id>"} (what the Vobiz playground
 * sends), verified by GET; then the documented {"application":<integer>},
 * spliced in as text — a 17-digit id would be rounded by any trip through a
 * JS number.
 */
async function bindEndpoint(authId, authToken, endpointId, appId) {
  if (!isDigits(appId)) throw new VobizApiError("application id is not numeric", 500);
  const boundId = r => {
    const app = r.json && r.json.application;
    if (app && typeof app === "object" && app.app_id != null) return String(app.app_id);
    if (app != null && typeof app !== "object") return String(app);
    return r.json && r.json.app_id != null ? String(r.json.app_id) : "";
  };
  await vobiz(authId, authToken, "POST", `/Endpoint/${encodeURIComponent(endpointId)}/`, '{"app_id":"' + appId + '"}');
  let check = await readEndpoint(authId, authToken, endpointId);
  if (boundId(check) === appId) {
    console.log(`[vobiz] ${authId}: endpoint ${endpointId} bound to application ${appId} (app_id)`);
    return true;
  }
  await vobiz(authId, authToken, "POST", `/Endpoint/${encodeURIComponent(endpointId)}/`, '{"application":' + appId + "}");
  check = await readEndpoint(authId, authToken, endpointId);
  const ok = boundId(check) === appId;
  console[ok ? "log" : "warn"](`[vobiz] ${authId}: endpoint ${endpointId} ${ok ? "bound" : "NOT bound"} to application ${appId} after retry with the documented "application"`);
  return ok;
}

/** Existing endpoint gets a new password; a vanished one is recreated. */
async function provisionEndpoint(authId, authToken, agentId, appId) {
  const password = newPassword();
  let rec = getStoredEndpoint(authId, agentId) || await findEndpointByAlias(authId, authToken, agentId);
  if (rec) {
    const r = await vobiz(authId, authToken, "POST", `/Endpoint/${encodeURIComponent(rec.endpointId)}/`, JSON.stringify({ password }));
    if (r.status === 404) {
      dropStoredEndpoint(authId, agentId);
      rec = null;
    } else if (!r.ok) {
      throw new VobizApiError(`resetting the SIP password failed (${r.status})`, r.status);
    } else {
      const got = await readEndpoint(authId, authToken, rec.endpointId);
      if (got.ok && got.json.username) rec.username = String(got.json.username);
    }
  }
  if (!rec) rec = await createEndpoint(authId, authToken, agentId, password);
  putStoredEndpoint(authId, agentId, rec);
  const bound = await bindEndpoint(authId, authToken, rec.endpointId, appId);
  return { ...rec, password, bound };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify the pair, provision app + endpoint, and record the session.
 * Returns what the browser needs — the SIP password included, exactly once.
 * The auth token is never part of the result.
 */
async function signIn({ agentId, authId, authToken, callerId, publicBaseUrl }) {
  authId = String(authId || "").trim();
  authToken = String(authToken || "").trim();
  if (!/^[A-Za-z0-9_]{4,64}$/.test(authId) || !authToken) throw new VobizAuthError("enter your Vobiz Auth ID and Auth Token");
  if (!publicBaseUrl) throw new VobizApiError("PUBLIC_BASE_URL is not set on this backend", 500);

  const numberInfo = await listNumbers(authId, authToken);
  const numbers = numberInfo.map(n => n.e164);
  const appId = await findOrCreateApplication(authId, authToken, publicBaseUrl);
  accounts.set(authId, { authToken, numbers, numberInfo, appId });

  const ep = await provisionEndpoint(authId, authToken, agentId, appId);

  signOut(agentId);
  // Default: the agent's last choice on this account, else the first number.
  const chosen = pickCallerId(numbers, callerId || lastChoice.get(storeKey(authId, agentId)));
  if (chosen) lastChoice.set(storeKey(authId, agentId), chosen);
  agentSessions.set(agentId, { mode: "account", authId, sipUser: ep.username, endpointId: ep.endpointId, callerId: chosen });
  sipUsers.set(ep.username.toLowerCase(), agentId);
  console.log(`[vobiz] agent ${agentId} signed in to ${authId} as ${ep.username}`);
  return {
    authId,
    sipUser: `${ep.username}@registrar.vobiz.ai`,
    sipPassword: ep.password,
    numbers: numberInfo.map(n => ({ e164: n.e164, applicationId: n.applicationId, ours: n.applicationId === appId })),
    applicationId: appId,
    callerId: chosen,
    applicationBound: ep.bound,
  };
}

/** "+91 00000-00001" -> "+910000000001"; null unless 8–15 digits. */
function cleanPhone(raw) {
  const v = String(raw || "").trim();
  if (!/^\+?[\d\s().-]+$/.test(v)) return null;
  const d = digitsOf(v);
  return d.length >= 8 && d.length <= 15 ? `+${d}` : null;
}

/**
 * SIP-direct sign-in. Takes the username (never the password) and the
 * caller ID; Vobiz itself refuses a caller ID the account does not own.
 */
function signInSipDirect({ agentId, sipUser, callerId }) {
  const user = String(sipUser || "").trim().replace(/^sips?:/i, "").split("@")[0];
  if (!/^[A-Za-z0-9]{1,64}$/.test(user)) throw new VobizApiError("enter the endpoint's SIP username (letters and digits)", 400);
  const number = cleanPhone(callerId);
  if (!number) throw new VobizApiError("enter a caller ID in E.164, e.g. +<country code><number>", 400);
  const holder = sipUsers.get(user.toLowerCase());
  if (holder && holder !== agentId) throw new VobizApiError("that SIP username is already signed in by another agent", 409);
  signOut(agentId);
  agentSessions.set(agentId, { mode: "sip", authId: null, sipUser: user, endpointId: null, callerId: number, inboundNumber: number });
  sipUsers.set(user.toLowerCase(), agentId);
  console.log(`[vobiz] agent ${agentId} signed in SIP-direct as ${user}`);
  return { mode: "sip", sipUser: `${user}@registrar.vobiz.ai`, callerId: number };
}

function pickCallerId(numbers, requested) {
  if (requested) {
    const want = digitsOf(requested);
    const hit = numbers.find(n => digitsOf(n) === want);
    if (hit) return hit;
  }
  return numbers[0] || null;
}

function setCallerId(agentId, requested) {
  const s = agentSessions.get(agentId);
  if (!s || s.mode !== "account") return null;
  const acct = accounts.get(s.authId);
  const want = digitsOf(requested);
  const hit = acct && acct.numbers.find(n => digitsOf(n) === want);
  if (!hit) return null;
  s.callerId = hit;
  lastChoice.set(storeKey(s.authId, agentId), hit);
  return hit;
}

function signOut(agentId) {
  const s = agentSessions.get(agentId);
  if (!s) return;
  agentSessions.delete(agentId);
  if (sipUsers.get(s.sipUser.toLowerCase()) === agentId) sipUsers.delete(s.sipUser.toLowerCase());
}

const sessionFor = agentId => agentSessions.get(agentId) || null;

/** "sip:zohopriya1a2b3c@registrar.vobiz.ai" -> { agentId, authId, callerId, sipUser }. */
function sessionForSipFrom(from) {
  const m = String(from || "").match(/^sips?:([^@;>]+)@/i);
  if (!m) return null;
  const agentId = sipUsers.get(m[1].toLowerCase());
  const s = agentId && agentSessions.get(agentId);
  return s ? { agentId, ...s } : null;
}

/** The signed-in account that owns a dialled DID, and its signed-in agents. */
function accountForNumber(raw) {
  const want = digitsOf(raw);
  if (!want) return null;
  for (const [authId, acct] of accounts) {
    const number = acct.numbers.find(n => digitsOf(n) === want);
    if (number) {
      const agents = [...agentSessions].filter(([, s]) => s.authId === authId).map(([agentId, s]) => ({ agentId, ...s }));
      return { authId, number, agents };
    }
  }
  // SIP-direct agents: their caller ID is their inbound number.
  const sipAgents = [...agentSessions].filter(([, s]) => s.mode === "sip" && digitsOf(s.inboundNumber) === want)
    .map(([agentId, s]) => ({ agentId, ...s }));
  if (sipAgents.length) return { authId: null, number: sipAgents[0].inboundNumber, agents: sipAgents };
  return null;
}

/** Signed-in Vobiz-account agents of one account (inbound routing by ParentAuthID). */
function agentsForAccount(authId) {
  if (!authId || !accounts.has(authId)) return [];
  return [...agentSessions].filter(([, s]) => s.authId === authId).map(([agentId, s]) => ({ agentId, ...s }));
}

/**
 * Caller ID a browser asked for in X-VH-Caller-ID. Strict E.164; on a
 * Vobiz-account session it must also be one of that account's numbers.
 */
function headerCallerId(session, raw) {
  const v = String(raw || "").trim();
  if (!/^\+?[1-9]\d{7,14}$/.test(v)) return null;
  const number = `+${digitsOf(v)}`;
  if (session.mode === "account") {
    const acct = accounts.get(session.authId);
    return acct && acct.numbers.includes(number) ? number : null;
  }
  return number;
}

/** The token is read only through here, and only for server-side calls. */
const tokenFor = authId => (authId && accounts.has(authId) ? accounts.get(authId).authToken : null);
const knownAccount = authId => Boolean(authId && accounts.has(authId));

/** "Enable inbound calls": attach one of the account's DIDs to our application. */
async function attachNumber(agentId, number) {
  const s = agentSessions.get(agentId);
  const acct = s && accounts.get(s.authId);
  if (!acct) throw new VobizApiError("sign in with your Vobiz account to use this", 400);
  const want = digitsOf(number);
  const e164 = acct.numbers.find(n => digitsOf(n) === want);
  if (!e164) throw new VobizApiError("that number is not on your Vobiz account", 400);
  const body = '{"application_id":"' + acct.appId + '"}';
  const r = await vobiz(s.authId, acct.authToken, "POST", `/numbers/%2B${digitsOf(e164)}/application`, body);
  if (!r.ok) throw new VobizApiError(`Vobiz refused to attach ${e164} (${r.status})`, r.status);
  const info = acct.numberInfo.find(n => n.e164 === e164);
  const previous = info ? info.applicationId : null;
  if (info) info.applicationId = acct.appId;
  console.log(`[vobiz] ${s.authId}: ${e164} now answers on application ${acct.appId}`);
  return { number: e164, applicationId: acct.appId, previousApplicationId: previous };
}

/** Admin status — ids and counts only. */
function listSignedIn() {
  const sipDirect = [...agentSessions].filter(([, s]) => s.mode === "sip").map(([id]) => id);
  return [...accounts].map(([authId, a]) => ({
    authId,
    numbers: a.numbers.length,
    applicationId: a.appId,
    agents: [...agentSessions].filter(([, s]) => s.authId === authId).map(([id]) => id),
  })).concat(sipDirect.length ? [{ authId: null, mode: "sip", agents: sipDirect }] : []);
}

module.exports = {
  signIn,
  signInSipDirect,
  cleanPhone,
  signOut,
  setCallerId,
  sessionFor,
  sessionForSipFrom,
  accountForNumber,
  agentsForAccount,
  headerCallerId,
  tokenFor,
  knownAccount,
  attachNumber,
  listSignedIn,
  parseVobizJson,
  storeFile,
  resetForTests,
  VobizAuthError,
  VobizApiError,
};
