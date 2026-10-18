"use strict";

/**
 * Zoho PhoneBridge V3 integration.
 *
 * What shapes it:
 *
 *   - It is a PUBLIC integration. Any Zoho customer who installs VoBiz from
 *     the Telephony Marketplace becomes a tenant here, so tokens are stored
 *     per-org, never globally.
 *   - Zoho runs ELEVEN datacentres (confirmed live against
 *     accounts.zoho.com/oauth/serverinfo). A customer's data lives in exactly one, the
 *     domains are not interchangeable, and Zoho explicitly forbids hardcoding
 *     them. Every domain in this file is resolved at runtime.
 *   - It is server-to-server. Zoho draws the entire UI; we expose a
 *     click-to-dial endpoint and report call state back. There is no widget.
 *
 * API contract implemented here (Zoho PhoneBridge V3):
 *   POST   {api_domain}/phonebridge/v3/clicktodial   register our dial URI
 *   DELETE {api_domain}/phonebridge/v3/clicktodial   deregister it
 *   POST   {api_domain}/phonebridge/v3/callnotify    report call state
 *
 * callnotify takes form-encoded:
 *   type        received | dialed
 *   state       ringing | answered | missed | ended
 *   id          our call id (must be stable across all states of one call)
 *   from, to    E.164
 *   start_time  "yyyy-MM-dd HH:mm:ss" in GMT   (state=ended or missed)
 *   duration    seconds                        (state=ended)
 *   voiceuri    recording URL                  (state=ended, optional)
 *   zohouser    PhoneBridge user id            (optional)
 *
 * Auth header is `Zoho-oauthtoken <token>`, NOT `Bearer`.
 */

// The ONLY constant domain in this file, and Zoho documents it as the fixed
// entry point: it is the directory that tells you every other domain.
const SERVERINFO_URL = "https://accounts.zoho.com/oauth/serverinfo";

// PhoneBridge scopes. Note these are NOT the ZohoCRM.* scopes — asking for
// those yields a token
// that authenticates fine and then 401s on every PhoneBridge call.
const PHONEBRIDGE_SCOPES = ["PhoneBridge.call.log", "PhoneBridge.zohoone.search"].join(",");

// ---------------------------------------------------------------------------
// Datacentre resolution
// ---------------------------------------------------------------------------

let serverInfoCache = null;
let serverInfoFetchedAt = 0;
const SERVERINFO_TTL_MS = 6 * 60 * 60 * 1000; // 6h — Zoho may add datacentres

/**
 * Returns { us: "https://accounts.zoho.com", eu: ..., in: ..., ... }.
 * Cached, because this is on the hot path of every token refresh.
 */
async function resolveServerInfo({ force = false } = {}) {
  const fresh = Date.now() - serverInfoFetchedAt < SERVERINFO_TTL_MS;
  if (serverInfoCache && fresh && !force) return serverInfoCache;

  const res = await fetch(SERVERINFO_URL);
  if (!res.ok) {
    // Serve a stale cache rather than failing a live call over this.
    if (serverInfoCache) {
      console.warn(`[zoho-pb] serverinfo fetch failed (${res.status}) — using cached copy`);
      return serverInfoCache;
    }
    throw new Error(`Zoho serverinfo fetch failed: ${res.status}`);
  }
  const json = await res.json();
  if (!json.locations || typeof json.locations !== "object") {
    throw new Error(`Zoho serverinfo returned an unexpected shape: ${JSON.stringify(json)}`);
  }
  serverInfoCache = json.locations;
  serverInfoFetchedAt = Date.now();
  console.log(`[zoho-pb] serverinfo resolved — ${Object.keys(serverInfoCache).length} datacentres`);
  return serverInfoCache;
}

/**
 * `location` arrives as a query param on the OAuth callback ("us", "eu",
 * "in", ...). Anything we do for this customer afterwards has to go to the
 * domain it maps to.
 */
async function accountsDomainForLocation(location) {
  const locations = await resolveServerInfo();
  const domain = locations[location];
  if (!domain) {
    // Refresh once before giving up — a brand new datacentre would look
    // exactly like this against a stale cache.
    const refreshed = await resolveServerInfo({ force: true });
    if (refreshed[location]) return refreshed[location];
    throw new Error(
      `Unknown Zoho location "${location}". Known: ${Object.keys(refreshed).join(", ")}`,
    );
  }
  return domain;
}

// ---------------------------------------------------------------------------
// Per-org token store
// ---------------------------------------------------------------------------
//
// Encrypted at rest and keyed by org — see token-store.js. Every Zoho customer
// that connects gets its own record under its own id, so a second customer
// never displaces the first, and the file survives a restart as long as it is
// on a persistent disk (DATA_DIR).

const { createTokenStore } = require("./token-store");
let store = createTokenStore();

/** Tests point the module at a throwaway file. */
function useStore(next) {
  store = next;
}

function getOrg(orgId) {
  return store.get(orgId);
}

function saveOrg(orgId, patch) {
  return store.put(orgId, patch);
}

function removeOrg(orgId) {
  return store.remove(orgId);
}

function listOrgs() {
  // Never hand tokens back to a caller that only wants to know who is connected.
  return store.listPublic().map(o => ({
    orgId: o.orgId,
    location: o.location,
    accountsDomain: o.accountsDomain,
    apiDomain: o.apiDomain,
    scope: o.scope,
    clickToDialRegistered: Boolean(o.clickToDialUri || (o.registrations && o.registrations.length)),
    registrations: (o.registrations || []).map(r => ({ agentId: r.agentId, zohoUser: r.zohoUser || null })),
    agentMap: o.agentMap || {},
    defaultAgentId: o.defaultAgentId || null,
    connectedAt: o.connectedAt,
    updatedAt: o.updatedAt,
    tokenExpiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : null,
  }));
}

/** The org an agent belongs to, by mapping or as its default agent. */
function orgForAgent(agentId) {
  if (!agentId) return null;
  const hit = store.listPublic().find(o =>
    (o.agentMap && Object.prototype.hasOwnProperty.call(o.agentMap, agentId)) || o.defaultAgentId === agentId);
  return hit ? hit.orgId : null;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/**
 * Where we send the customer to consent. Built against the US accounts
 * domain on purpose: Zoho's own flow redirects the user to their home
 * datacentre from here and tells us which one that was via `location` on
 * the callback. We must not guess it up front.
 */
function buildAuthUrl({ clientId, redirectUri, state, accountsDomain }) {
  // A client registered at api-console.zoho.IN exists only in the India
  // datacentre unless Multi-DC is switched on for it, and starting the flow
  // at accounts.zoho.com then fails with an invalid-client error. Callers can
  // pass the client's home accounts domain to start there instead. For a real
  // Multi-DC partner client, leave this unset and start at .com as Zoho
  // intends.
  const base = accountsDomain || "https://accounts.zoho.com";
  const authUrl = new URL(`${base}/oauth/v2/auth`);
  authUrl.searchParams.set("scope", PHONEBRIDGE_SCOPES);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  if (state) authUrl.searchParams.set("state", state);
  return authUrl.toString();
}

/**
 * Exchange the authorization code against the datacentre the customer
 * actually lives in, then remember every domain we were told about so no
 * later request has to guess.
 */
async function exchangeCodeForTokens({ code, location, clientId, clientSecret, redirectUri }) {
  const accountsDomain = await accountsDomainForLocation(location);

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code,
  });

  const res = await fetch(`${accountsDomain}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const json = await res.json();

  if (!json.access_token) {
    throw new Error(`Zoho token exchange failed: ${JSON.stringify(json)}`);
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    // api_domain comes back FROM Zoho — this is the customer's zohoapis host
    // and is the other half of "never hardcode a domain".
    apiDomain: json.api_domain,
    accountsDomain,
    location,
    scope: json.scope,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  };
}

/**
 * Per-org access token, refreshed proactively. The 60s margin stops a token
 * expiring mid-call — a refresh is cheap, a dropped call-state update is not.
 */
async function getAccessToken(orgId, { clientId, clientSecret }) {
  const org = getOrg(orgId);
  if (!org) throw new Error(`No Zoho org connected with id "${orgId}"`);
  if (org.accessToken && Date.now() < org.expiresAt - 60_000) return org.accessToken;

  if (!org.refreshToken) {
    throw new Error(`Zoho org "${orgId}" has no refresh token — it must reconnect`);
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: org.refreshToken,
  });

  // Against THIS org's accounts domain, not a global one.
  const res = await fetch(`${org.accountsDomain}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const json = await res.json();
  if (!json.access_token) {
    throw new Error(`Zoho token refresh failed for org "${orgId}": ${JSON.stringify(json)}`);
  }

  const updated = saveOrg(orgId, {
    accessToken: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
  });
  console.log(`[zoho-pb] refreshed access token for org ${orgId}`);
  return updated.accessToken;
}

// ---------------------------------------------------------------------------
// PhoneBridge API calls
// ---------------------------------------------------------------------------

async function phonebridgePost(orgId, endpoint, form, credentials, method = "POST") {
  const org = getOrg(orgId);
  if (!org) throw new Error(`No Zoho org connected with id "${orgId}"`);
  const accessToken = await getAccessToken(orgId, credentials);

  const init = {
    method,
    headers: {
      // Zoho-oauthtoken, not Bearer. Using Bearer here 401s.
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  };
  // fetch() throws outright if a GET carries a body, so only attach one when
  // there is something to send.
  if (method !== "GET" && method !== "HEAD") {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form || {}).toString();
  }

  const res = await fetch(`${org.apiDomain}/phonebridge/v3/${endpoint}`, init);

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, body: json };
}

/** "yyyy-MM-dd HH:mm:ss" in GMT, which is the only format callnotify accepts. */
function toZohoGmt(epochMs) {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Report one state transition of one call.
 *
 * `callId` must stay identical across ringing -> answered -> ended for a
 * single call, otherwise Zoho treats each update as a different call and the
 * UI gets stuck showing calls that already finished.
 */
async function notifyCall({
  orgId,
  type,          // "dialed" (outbound) | "received" (inbound)
  state,         // "ringing" | "answered" | "missed" | "ended"
  callId,
  from,
  to,
  startedAtMs,   // required when state === "ended"
  durationSec,   // required when state === "ended"
  voiceUri,      // optional recording URL
  zohoUser,      // optional
  credentials,
}) {
  const form = { type, state, id: callId, from, to };
  // Each state sends exactly the parameters Zoho documents for it. `missed`
  // REQUIRES start_time (Zoho's missed-call page marks it mandatory) — sending
  // it bare is what produced the 400s once read as "Zoho rejects missed".
  // `ringing` and `answered` must NOT carry start_time: Zoho answers
  // INVALID_REQUEST to the extra parameter.
  if (state === "ended" || state === "missed") {
    form.start_time = toZohoGmt(startedAtMs || Date.now());
    if (voiceUri) form.voiceuri = voiceUri;
  }
  if (state === "ended") {
    form.duration = String(Math.max(0, Math.round(durationSec || 0)));
  }
  if (zohoUser) form.zohouser = zohoUser;

  const result = await phonebridgePost(orgId, "callnotify", form, credentials);
  const label = `${type}/${state} call ${callId}`;
  if (result.ok) {
    console.log(`[zoho-pb] notified Zoho: ${label}`);
  } else {
    console.warn(`[zoho-pb] callnotify FAILED for ${label} — ${result.status}`, result.body);
  }
  return result;
}

/**
 * Tell Zoho a click-to-dial request could not be turned into a call.
 *
 * Without this, a dial that fails on our side leaves Zoho showing a call bar
 * for a call that will never happen, and the user is given no reason why: we
 * answer their click-to-dial request with an HTTP error and say nothing more.
 *
 * Form params are the same three Zoho documents — `from`, `to`, `code`. The
 * `code` values themselves are NOT enumerated anywhere in the V3 docs, so we
 * send a short uppercase token naming our own failure and log Zoho's reply
 * verbatim: a 400 here is the signal that they want a value from a fixed set,
 * and the response is the only place that will tell us which.
 */
async function notifyClickToDialError({ orgId, from, to, code, credentials }) {
  const form = { from: from || "", to: to || "", code: code || "CALL_FAILED" };
  const result = await phonebridgePost(orgId, "clicktodialerror", form, credentials);
  if (result.ok) {
    console.log(`[zoho-pb] reported click-to-dial error to Zoho: ${form.code} (to ${form.to})`);
  } else {
    console.warn(
      `[zoho-pb] clicktodialerror FAILED — ${result.status}`,
      result.body,
      `(sent ${JSON.stringify(form)})`,
    );
  }
  return result;
}

/**
 * Activate the PBX integration for an org. THIS MUST HAPPEN FIRST.
 *
 * Until it is called, every other PhoneBridge endpoint — clicktodial,
 * callnotify, users — rejects the org with PBX_NOT_INTEGRATED, even though
 * Zoho's own admin screens report the provider as installed. The endpoint is
 * not in the V3 developer docs.
 *
 * Takes no parameters: the org is identified by the access token.
 * Safe to call repeatedly — Zoho answers SUCCESS whether or not the
 * integration was already active.
 */
async function integrate({ orgId, credentials }) {
  const result = await phonebridgePost(orgId, "integrate", {}, credentials);
  if (result.ok) {
    saveOrg(orgId, { integratedAt: new Date().toISOString() });
    console.log(`[zoho-pb] PBX integration activated for org ${orgId}`);
  } else {
    console.warn(`[zoho-pb] integrate FAILED for org ${orgId} — ${result.status}`, result.body);
  }
  return result;
}

/**
 * The Zoho users this org has, each with the `zohouser` id that callnotify
 * needs in order to address an event to one specific person rather than the
 * org as a whole. Only returns anything after integrate() has succeeded.
 */
async function listZohoUsers({ orgId, credentials }) {
  const result = await phonebridgePost(orgId, "users", undefined, credentials, "GET");
  if (!result.ok) {
    console.warn(`[zoho-pb] users lookup FAILED for org ${orgId}`, result.body);
    return [];
  }
  const users = (result.body && result.body.users) || [];
  console.log(`[zoho-pb] org ${orgId} has ${users.length} Zoho user(s)`);
  return users;
}

/** Tell Zoho where to send click-to-dial requests for this org. */
/**
 * Tell Zoho where to send click-to-dial requests for this org.
 *
 * With `zohoUser`, the registration is for that one Zoho user — Zoho's V3
 * clicktodial docs: "To enable clicktodial for multiple users, call this API
 * multiple times by passing the zohouser parameter". That is how one org gets
 * one click-to-dial URI per agent.
 */
async function registerClickToDial({ orgId, clickToDialUri, credentials, authorizationParam, zohoUser }) {
  const form = { clicktodialuri: clickToDialUri };
  if (zohoUser) form.zohouser = String(zohoUser);
  if (authorizationParam) form.authorizationparam = JSON.stringify(authorizationParam);

  const result = await phonebridgePost(orgId, "clicktodial", form, credentials);
  if (result.ok) {
    if (!zohoUser) saveOrg(orgId, { clickToDialUri });
    console.log(`[zoho-pb] click-to-dial registered for org ${orgId}${zohoUser ? ` user ${zohoUser}` : ""}`);
  } else {
    console.warn(`[zoho-pb] click-to-dial registration FAILED for org ${orgId}`, result.body);
  }
  return result;
}

async function unregisterClickToDial({ orgId, credentials, zohoUser }) {
  const form = zohoUser ? { zohouser: String(zohoUser) } : {};
  const result = await phonebridgePost(orgId, "clicktodial", form, credentials, "DELETE");
  if (result.ok && !zohoUser) saveOrg(orgId, { clickToDialUri: null });
  return result;
}

// ---------------------------------------------------------------------------
// Call correlation
// ---------------------------------------------------------------------------
//
// Maps a VoBiz call to the Zoho org and call id it belongs to, so later
// webhooks (answer, dial-result, recording-ready) know who to report to.
// In-memory: a restart loses in-flight calls, which for a call already in
// progress only costs the final state update. Moves to the DB alongside the
// token store.

const activeCalls = new Map(); // vobizCallUuid -> { orgId, callId, type, from, to, startedAtMs, zohoUser, answeredAtMs, agentId }

function trackCall(vobizCallUuid, record) {
  activeCalls.set(vobizCallUuid, { ...record, startedAtMs: record.startedAtMs || Date.now() });
  return activeCalls.get(vobizCallUuid);
}

function getTrackedCall(vobizCallUuid) {
  return activeCalls.get(vobizCallUuid) || null;
}

function updateTrackedCall(vobizCallUuid, patch) {
  const existing = activeCalls.get(vobizCallUuid);
  if (!existing) return null;
  const merged = { ...existing, ...patch };
  activeCalls.set(vobizCallUuid, merged);
  return merged;
}

function untrackCall(vobizCallUuid) {
  const record = activeCalls.get(vobizCallUuid);
  activeCalls.delete(vobizCallUuid);
  return record || null;
}

function listActiveCalls() {
  return Array.from(activeCalls.entries()).map(([uuid, rec]) => ({ vobizCallUuid: uuid, ...rec }));
}

module.exports = {
  PHONEBRIDGE_SCOPES,
  SERVERINFO_URL,
  resolveServerInfo,
  accountsDomainForLocation,
  buildAuthUrl,
  exchangeCodeForTokens,
  getAccessToken,
  getOrg,
  saveOrg,
  removeOrg,
  listOrgs,
  orgForAgent,
  useStore,
  notifyCall,
  notifyClickToDialError,
  integrate,
  listZohoUsers,
  registerClickToDial,
  unregisterClickToDial,
  toZohoGmt,
  trackCall,
  getTrackedCall,
  updateTrackedCall,
  untrackCall,
  listActiveCalls,
};
