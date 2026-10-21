"use strict";

/**
 * End-to-end tests for the Zoho PhoneBridge backend.
 *
 *   node test-zoho-phonebridge.js
 *
 * Hermetic: a mock Zoho (OAuth + PhoneBridge V3) runs on localhost, Vobiz's
 * REST API (two fake accounts, MA_TEST0001 and MA_TEST0002) and Zoho's
 * serverinfo directory are stubbed, and every file the
 * backend writes goes to a throwaway directory. Nothing touches the network,
 * a real Zoho org or a real Vobiz account.
 *
 * The mock Zoho is strict in the way the live API is: it refuses a callnotify
 * that is MISSING a parameter its state requires (start_time on missed/ended)
 * and one that carries a parameter its state does not take (start_time on
 * ringing/answered). A mock that is more permissive than the real thing hides
 * exactly the bugs that lose call logs.
 *
 * Not covered, because it cannot be without live systems: Zoho's consent
 * screen, Zoho's UI rendering, and real SIP/RTP.
 */

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");

// --- Isolated environment, set before anything is required ---------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "vobiz-zoho-test-"));
// The mock Zoho listens on a free port, set once it is up — a fixed port
// collides with anything else running on the machine.
let MOCK = "";
const AGENTS_FILE = path.join(TMP, "agents.json");
const ENC_KEY = crypto.randomBytes(32).toString("base64");

Object.assign(process.env, {
  DATA_DIR: TMP,
  AGENTS_FILE,
  APP_SECRET: crypto.randomBytes(32).toString("hex"),
  TOKEN_ENCRYPTION_KEY: ENC_KEY,
  ADMIN_TOKEN: "test-admin-token-123",
  ALLOWED_ORIGINS: "https://crm.zoho.in",
  PUBLIC_BASE_URL: "https://example.test",
  ZOHO_PB_CLIENT_ID: "1000.TESTCLIENT",
  ZOHO_PB_CLIENT_SECRET: "test-client-secret",
  ZOHO_PB_REDIRECT_URI: "https://example.test/oauth/zoho/callback",
  ZOHO_PB_RECORDING_GRACE_MS: "60000",
});
for (const k of ["VOBIZ_AUTH_ID", "VOBIZ_AUTH_TOKEN", "VOBIZ_FROM_NUMBER", "REQUIRE_VOBIZ_SIGNATURE", "ALLOW_AGENT_AUTH_TOKEN", "CLICKTODIAL_WHEN_OFFLINE", "ZOHO_PB_SEND_MISSED_STATE", "RECORDING_URL_SECRET", "OUTBOUND_RECORD", "INBOUND_RECORD", "CLICK_TO_DIAL_TIMEOUT_MS"]) delete process.env[k];
// Sections [1]–[16] and [21] exercise call flows, not authentication: they
// post unsigned webhooks and sign agents in with a typed Auth Token, so they
// run with both old behaviours switched back on. Sections [19] and [20] switch
// them off and test the defaults — signatures required, token sign-in refused.
process.env.REQUIRE_VOBIZ_SIGNATURE = "false";
process.env.ALLOW_AGENT_AUTH_TOKEN = "true";

fs.writeFileSync(AGENTS_FILE, JSON.stringify({
  priya: { displayName: "Priya", zohoUser: "600001" },
  arjun: { displayName: "Arjun", email: "Arjun@Example.com" },
  nomatch: { displayName: "Unmapped" },
}, null, 2));

let pass = 0;
let fail = 0;
function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}`);
    if (detail !== undefined) console.log(`      got: ${JSON.stringify(detail).slice(0, 400)}`);
  }
}

// --- Mock Zoho -------------------------------------------------------------

const received = [];
const ZOHO_USERS = [
  { zohouser: "600001", email: "priya@example.com", username: "Priya" },
  { zohouser: "600002", email: "arjun@example.com", username: "Arjun" },
  { zohouser: "600003", email: "someone@example.com", username: "Someone" },
];
let codeCounter = 0;
// The ringing notification for this one number is held back, as a slow
// network would: anything sent after it without waiting for it lands first.
const SLOW_RINGING_TO = "+910000900086";

const CALLNOTIFY_RULES = {
  ringing: { required: [], forbidden: ["start_time", "duration"] },
  answered: { required: [], forbidden: ["start_time", "duration"] },
  missed: { required: ["start_time"], forbidden: ["duration"] },
  ended: { required: ["start_time", "duration"], forbidden: [] },
};

function startMockZoho() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", c => (raw += c));
      req.on("end", () => {
        const u = new URL(req.url, MOCK);
        const fields = Object.fromEntries(new URLSearchParams(raw));
        const record = () => received.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: req.method, auth: req.headers.authorization, contentType: req.headers["content-type"], fields });
        const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
        if (u.pathname === "/phonebridge/v3/callnotify" && fields.state === "ringing" && fields.to === SLOW_RINGING_TO) {
          return setTimeout(() => { record(); json(200, { status: "success", code: "SUCCESS" }); }, 150);
        }
        record();

        if (u.pathname === "/oauth/v2/token") {
          if (fields.grant_type === "authorization_code") {
            if (fields.redirect_uri !== process.env.ZOHO_PB_REDIRECT_URI) return json(200, { error: "invalid_redirect_uri" });
            codeCounter += 1;
            return json(200, { access_token: `access-${fields.code}`, refresh_token: `refresh-${fields.code}`, api_domain: MOCK, expires_in: 3600, scope: "PhoneBridge.call.log" });
          }
          return json(200, { access_token: "refreshed-access", api_domain: MOCK, expires_in: 3600 });
        }
        if (u.pathname === "/oauth/v2/token/revoke") return json(200, { status: "success" });
        if (!String(req.headers.authorization || "").startsWith("Zoho-oauthtoken ")) return json(401, { code: "INVALID_TOKEN" });
        if (u.pathname === "/phonebridge/v3/users") return json(200, { users: ZOHO_USERS });
        if (u.pathname === "/phonebridge/v3/callnotify") {
          const rule = CALLNOTIFY_RULES[fields.state];
          if (!rule) return json(400, { code: "INVALID_REQUEST" });
          const missing = rule.required.filter(f => !fields[f]);
          if (missing.length) return json(400, { code: "REQUIRED_PARAM_MISSING", missing });
          const extra = rule.forbidden.filter(f => f in fields);
          if (extra.length) return json(400, { code: "INVALID_REQUEST", extra });
        }
        json(200, { status: "success", code: "SUCCESS" });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      MOCK = `http://127.0.0.1:${server.address().port}`;
      resolve(server);
    });
  });
}

// --- Stubbed outside world --------------------------------------------------

const realFetch = globalThis.fetch;
let vobizCalls = [];
let recordingUrlForStub = "https://media.vobiz.ai/recordings/rec-1.mp3";

// Two fake Vobiz accounts. App ids are 17 digits and the mock writes them as
// bare JSON integers, the way a naive JSON.parse would silently round.
const OUR_APP_1 = "43919358318796814";
const NEW_APP_2 = "53919358318796815";
const TOKENS = { MA_TEST0001: "tok-one-secret-value", MA_TEST0002: "tok-two-secret-value" };
const vobizState = {
  MA_TEST0001: {
    numbers: ["+910000000001", "+910000000002"],
    apps: [
      { app_id: "11111111111111111", app_name: "someone-elses", answer_url: "https://other.example/answer" },
      { app_id: OUR_APP_1, app_name: "Vobiz-Zoho-PhoneBridge", answer_url: "https://example.test/answer" },
    ],
    endpoints: {},
  },
  MA_TEST0002: { numbers: ["+910000000003"], apps: [], endpoints: {} },
};
let endpointSeq = 9000;
const bareIds = text => text.replace(/"app_id":"(\d{16,})"/g, '"app_id":$1');
const vjson = (status, obj) => new Response(bareIds(JSON.stringify(obj)), { status, headers: { "Content-Type": "application/json" } });

function vobizMock(target, init) {
  const method = (init.method || "GET").toUpperCase();
  const h = init.headers || {};
  const body = String(init.body || "");
  vobizCalls.push({ target, method, headers: h, body });
  const u = new URL(target);
  const m = u.pathname.match(/^\/api\/v1\/Account\/([^/]+)(\/.*)$/);
  if (!m) return vjson(404, { error: "not found" });
  const authId = decodeURIComponent(m[1]);
  const rest = m[2];
  const acct = vobizState[authId];
  if (!acct || h["X-Auth-ID"] !== authId || h["X-Auth-Token"] !== TOKENS[authId]) return vjson(401, { error: "invalid credentials" });

  if (method === "GET" && rest === "/numbers") {
    // Two pages for MA_TEST0001 (per_page honoured as 1 there), plus a
    // released and a voice-disabled number that must never be offered.
    const all = acct.numbers.map(n => ({ id: `id-${n}`, account_id: authId, e164: n, status: "active", voice_enabled: true, application_id: (acct.numberApps && acct.numberApps[n]) || OUR_APP_1 }))
      .concat(authId === "MA_TEST0001" ? [
        { id: "x1", e164: "+910000000098", status: "released", voice_enabled: true },
        { id: "x2", e164: "+910000000099", status: "active", voice_enabled: false },
      ] : []);
    const per = authId === "MA_TEST0001" ? 2 : 100;
    const page = Number(u.searchParams.get("page") || 1);
    return vjson(200, { items: all.slice((page - 1) * per, page * per), page, per_page: per, total: all.length });
  }
  if (method === "GET" && rest === "/Application/") {
    return vjson(200, { meta: { limit: 100, offset: 0, next: null, total_count: acct.apps.length }, objects: acct.apps });
  }
  if (method === "POST" && rest === "/Application/") {
    const b = JSON.parse(body);
    acct.apps.push({ app_id: NEW_APP_2, app_name: b.app_name, answer_url: b.answer_url, hangup_url: b.hangup_url });
    return vjson(201, { api_id: "x", app_id: NEW_APP_2, message: "created" });
  }
  if (method === "GET" && rest === "/Endpoint/") {
    const objects = Object.values(acct.endpoints).map(e => ({ endpoint_id: e.endpoint_id, username: e.username, alias: e.alias }));
    return vjson(200, { meta: { limit: 100, offset: 0, next: null, total_count: objects.length }, objects });
  }
  if (method === "POST" && rest === "/Endpoint/") {
    const b = JSON.parse(body);
    if (!/^[A-Za-z0-9]+$/.test(b.username)) return vjson(400, { error: "invalid request parameters" });
    const id = String(endpointSeq++);
    // Vobiz rewrites the submitted username; the stored one differs.
    acct.endpoints[id] = { endpoint_id: id, username: `${b.username}${id}`, alias: b.alias, password: b.password, app: null };
    return vjson(201, { message: "created", endpoint_id: id, username: b.username });
  }
  let em = rest.match(/^\/Endpoint\/(\d+)\/$/);
  if (em) {
    const ep = acct.endpoints[em[1]];
    if (!ep) return new Response("", { status: 404 });
    if (method === "GET") {
      return vjson(200, { endpoint_id: ep.endpoint_id, username: ep.username, alias: ep.alias, application: ep.app ? { app_id: ep.app } : null });
    }
    // MA_TEST0001 behaves as documented ("application", integer) and ignores
    // "app_id"; MA_TEST0002 takes "app_id" as a string, as the playground sends.
    const appMatch = body.match(/^\{"application":(\d+)\}$/);
    const appIdMatch = body.match(/^\{"app_id":"(\d+)"\}$/);
    if (appMatch) {
      if (acct.apps.some(a => a.app_id === appMatch[1])) ep.app = appMatch[1];
      else return vjson(400, { error: "unknown app_id" });
    } else if (appIdMatch) {
      if (authId === "MA_TEST0002" && acct.apps.some(a => a.app_id === appIdMatch[1])) ep.app = appIdMatch[1];
    } else {
      const b = JSON.parse(body);
      if (b.password) ep.password = b.password;
    }
    return new Response("", { status: 202 });
  }
  em = rest.match(/^\/numbers\/%2B(\d+)\/application$/);
  if (em && method === "POST") {
    if (!acct.numbers.includes(`+${em[1]}`)) return vjson(404, { error: "not found" });
    return vjson(200, { message: "Number attached to application", number: `+${em[1]}` });
  }
  if (method === "GET" && /^\/Recording\/[^/]+\/$/.test(rest)) {
    return vjson(200, { recording_url: recordingUrlForStub, recording_format: "mp3" });
  }
  if (method === "GET" && /^\/Call\/([^/]+)\/$/.test(rest)) {
    const id = rest.match(/^\/Call\/([^/]+)\/$/)[1];
    return vjson(200, { bill_duration: id.startsWith("bleg") ? 37 : 99 });
  }
  return vjson(404, { error: "not found" });
}

globalThis.fetch = async (input, init = {}) => {
  const target = typeof input === "string" ? input : input.url;
  if (target === "https://accounts.zoho.com/oauth/serverinfo") {
    return new Response(JSON.stringify({ locations: { us: "https://accounts.zoho.com", in: "https://accounts.zoho.in", test: MOCK } }), { status: 200 });
  }
  // http:// too, so a backend that wrongly fetched one is caught here, offline.
  if (/^https?:\/\/media\.vobiz\.ai\//.test(target)) {
    vobizCalls.push({ target, method: "GET", headers: init.headers || {}, body: "" });
    return new Response("ID3-fake-mp3", { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  }
  if (target.startsWith("https://api.vobiz.ai/")) return vobizMock(target, init);
  return realFetch(input, init);
};

const pb = require("./zoho-phonebridge");
const { createTokenStore } = require("./token-store");
const vobizAccounts = require("./vobiz-accounts");
const { server, auth, finalizeZohoPhoneBridgeCall, verifyVobizSignature, routes } = require("./server");
let B = "";

// Every response this backend sends through req() is kept, so the suite can
// prove an Auth Token never leaves the server.
const seenResponses = [];
const req = async (p, opts = {}) => {
  const r = await realFetch(`${B}${p}`, { redirect: "manual", ...opts });
  const text = await r.clone().text().catch(() => "");
  seenResponses.push(`${p}\n${JSON.stringify([...r.headers])}\n${text}`);
  return r;
};
const form = obj => ({ "Content-Type": "application/x-www-form-urlencoded", body: new URLSearchParams(obj).toString() });
const post = (p, obj, headers = {}) => req(p, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(obj).toString() });
const postJson = (p, obj, headers = {}) => req(p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(obj) });
const ADMIN = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!pred() && Date.now() < end) await tick(20);
  return pred();
}
const notifies = () => received.filter(r => r.path === "/phonebridge/v3/callnotify");

// --- Tests -----------------------------------------------------------------

async function testServerInfoAndTime() {
  console.log("\n[1] Datacentres and timestamps");
  check("a known location resolves", (await pb.accountsDomainForLocation("in")) === "https://accounts.zoho.in");
  let threw = false;
  try { await pb.accountsDomainForLocation("atlantis"); } catch { threw = true; }
  check("an unknown location is rejected, not guessed", threw);
  const t = pb.toZohoGmt(Date.UTC(2026, 8, 15, 9, 5, 3));
  check('start_time is "yyyy-MM-dd HH:mm:ss" GMT', t === "2026-09-15 09:05:03", t);
}

async function testTokenStore() {
  console.log("\n[2] Token store — encrypted, per org, survives a restart");
  const file = path.join(TMP, "store-test.json");
  const store = createTokenStore({ file, key: ENC_KEY });
  store.put("org_a", { location: "in", apiDomain: "https://www.zohoapis.in", accessToken: "AAA-access", refreshToken: "AAA-refresh" });
  store.put("org_b", { location: "eu", apiDomain: "https://www.zohoapis.eu", accessToken: "BBB-access", refreshToken: "BBB-refresh" });

  const disk = fs.readFileSync(file, "utf8");
  check("no token is on disk in the clear", !disk.includes("AAA-refresh") && !disk.includes("BBB-access"));
  check("tokens are sealed as v1 AES-GCM", JSON.parse(disk).org_a.refreshToken.startsWith("v1:"));
  check("the file is 0600", (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
  check("non-secret fields stay readable", JSON.parse(disk).org_a.location === "in");

  const restarted = createTokenStore({ file, key: ENC_KEY });
  check("a new process reads both orgs back", restarted.get("org_a").refreshToken === "AAA-refresh" && restarted.get("org_b").refreshToken === "BBB-refresh");
  check("a second org does not displace the first", restarted.listPublic().length === 2);
  check("listings never carry tokens", restarted.listPublic().every(o => !("accessToken" in o) && !("refreshToken" in o)));

  const raw = JSON.parse(disk);
  raw.org_b.refreshToken = raw.org_a.refreshToken; // paste org A's sealed token into org B
  fs.writeFileSync(file, JSON.stringify(raw));
  let swapped = false;
  try { restarted.get("org_b"); } catch { swapped = true; }
  check("a ciphertext moved to another org does not decrypt", swapped);

  let wrongKey = false;
  try { createTokenStore({ file, key: crypto.randomBytes(32).toString("base64") }).get("org_a"); } catch { wrongKey = true; }
  check("the wrong key cannot read the store", wrongKey);

  let noKey = false;
  const saved = process.env.TOKEN_ENCRYPTION_KEY;
  delete process.env.TOKEN_ENCRYPTION_KEY;
  try { createTokenStore({ file: path.join(TMP, "nokey.json") }).put("x", { refreshToken: "r" }); } catch { noKey = true; }
  process.env.TOKEN_ENCRYPTION_KEY = saved;
  check("with no key nothing is written", noKey && !fs.existsSync(path.join(TMP, "nokey.json")));
}

async function testRouteAuth() {
  console.log("\n[3] Route authentication and the earlier leaks");
  {
    // Several integrations can share one host, each under its own prefix.
    const { cookiePathFor, createAuth } = require("./auth");
    check("cookie path is the base URL's path", cookiePathFor("https://integrations.example.com/zoho/") === "/zoho");
    check("cookie path is / at the root, or when unset", cookiePathFor("https://calling.example.com") === "/" && cookiePathFor(undefined) === "/");
    const prefixed = createAuth({ appSecret: "x".repeat(32), adminToken: "t", publicBaseUrl: "https://integrations.example.com/zoho" });
    const fakeReq = { socket: {}, headers: {} };
    check("agent and admin cookies are scoped to /zoho",
      /; Path=\/zoho;/.test(prefixed.agentCookie(fakeReq, "priya")) && /; Path=\/zoho;/.test(prefixed.adminCookie(fakeReq)));
    check("signing out clears the cookie on the same path", /; Path=\/zoho;/.test(prefixed.clearAgentCookie()));
  }
  let r = await req("/agent/priya");
  let body = await r.text();
  check("GET /agent/priya without a session is 401", r.status === 401, r.status);
  check("and never returns a sipPassword", !body.includes("sipPassword") && !body.includes("priya-sip-secret"), body);
  r = await req("/agent/anyone");
  check("GET /agent/anyone is 401, not a password", r.status === 401 && !(await r.text()).includes("sipPassword"));

  r = await req("/health", { headers: { Origin: "https://evil.example" } });
  check("an unknown Origin gets no Access-Control-Allow-Origin", r.headers.get("access-control-allow-origin") === null, r.headers.get("access-control-allow-origin"));
  r = await req("/health", { headers: { Origin: "https://crm.zoho.in" } });
  check("an allow-listed Origin is echoed, never *", r.headers.get("access-control-allow-origin") === "https://crm.zoho.in");

  for (const p of ["/../.env", "/../agents.json", "/public/../server.js", "/%2e%2e/.env", "/recording-file?url=https://example.com/"]) {
    const rr = await realFetch(`${B}${p}`);
    const t = await rr.text();
    check(`${p} is 404 and leaks nothing`, rr.status === 404 && !t.includes("APP_SECRET") && !t.includes("sipPassword") && !t.includes("Example Domain"), rr.status);
  }

  r = await postJson("/agent-session", { agentId: "priya", key: "wrong" });
  check("a wrong agent key is refused", r.status === 401);
  r = await postJson("/agent-session", { agentId: "priya", key: auth.agentKey("priya") });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  check("the right key issues an HttpOnly SameSite cookie", r.status === 200 && /HttpOnly/.test(r.headers.get("set-cookie")) && /SameSite=Strict/.test(r.headers.get("set-cookie")));
  r = await req("/agent/me", { headers: { Cookie: cookie } });
  body = await r.json();
  check("the signed-in agent reads who they are — and no SIP password", r.status === 200 && body.agentId === "priya" && !("sipPassword" in body) && body.vobiz === null, body);
  r = await req("/agent/arjun", { headers: { Cookie: cookie } });
  check("and cannot read another agent's", r.status === 403, r.status);
  const forged = cookie.replace(/=(.)/, "=X");
  r = await req("/agent/me", { headers: { Cookie: forged } });
  check("a tampered cookie is refused", r.status === 401);

  for (const [m, p] of [["GET", "/zoho/phonebridge/status"], ["GET", "/zoho/phonebridge/connect"], ["POST", "/zoho/phonebridge/register"], ["POST", "/zoho/phonebridge/complete"], ["GET", "/admin/agent-links"], ["POST", "/zoho/phonebridge/disconnect"]]) {
    const rr = await req(p, { method: m });
    check(`${m} ${p} without admin auth is 401`, rr.status === 401, rr.status);
  }
  r = await req("/zoho/phonebridge/status", { headers: { Authorization: "Bearer nope" } });
  check("a wrong admin token is 401", r.status === 401);
  r = await req("/zoho/phonebridge/status", { headers: ADMIN });
  check("the admin token opens status", r.status === 200);
  r = await post("/admin/session", { token: process.env.ADMIN_TOKEN });
  const adminCookie = (r.headers.get("set-cookie") || "").split(";")[0];
  r = await req("/admin/agent-links", { headers: { Cookie: adminCookie } });
  body = await r.json();
  check("the admin cookie works too, and agent links carry the key in the fragment",
    r.status === 200 && body.links.priya.includes("#agent=priya&key="), body);

  vobizCalls = [];
  r = await post("/zoho/phonebridge/clicktodial?orgId=whatever&agentId=priya", { tonumber: "+910000900001" });
  check("click-to-dial without its token is 401", r.status === 401);
  r = await post(`/zoho/phonebridge/clicktodial?orgId=whatever&agentId=arjun&t=${auth.clickToDialToken("whatever", "priya")}`, { tonumber: "+910000900001" });
  check("a token for one agent does not work for another", r.status === 401);
  check("and no call was placed", vobizCalls.length === 0, vobizCalls);
}

async function connectOrg() {
  let r = await req("/zoho/phonebridge/connect?dc=test", { headers: ADMIN });
  const loc = new URL(r.headers.get("location"));
  const state = loc.searchParams.get("state");
  const code = `code${codeCounter + 1}`;
  r = await req(`/oauth/zoho/callback?code=${code}&location=test&state=${encodeURIComponent(state)}&orgId=attacker`);
  return { status: r.status, body: await r.json(), loc };
}

async function testOAuth() {
  console.log("\n[4] OAuth — signed state, one record per org");
  let r = await req(`/oauth/zoho/callback?code=x&location=test&state=forged`);
  check("a forged state is refused", r.status === 400);
  r = await req(`/oauth/zoho/callback?code=x&location=test`);
  check("a missing state is refused", r.status === 400);

  const first = await connectOrg();
  check("connect redirects to Zoho with our redirect URI", first.loc.searchParams.get("redirect_uri") === process.env.ZOHO_PB_REDIRECT_URI);
  check("the callback completes and names the org", first.status === 200 && /^org_[0-9a-f]{16}$/.test(first.body.orgId), first.body);
  check("the org id comes from the signed state, not the query string", first.body.orgId !== "attacker");
  const second = await connectOrg();
  check("a second customer gets a second org", second.status === 200 && second.body.orgId !== first.body.orgId);
  check("and the first org is still there", Boolean(pb.getOrg(first.body.orgId)) && Boolean(pb.getOrg(second.body.orgId)));
  check("the token is stored encrypted on disk",
    !fs.readFileSync(path.join(TMP, "zoho-orgs.json"), "utf8").includes(`refresh-code`));
  check("the response does not echo the refresh token", !JSON.stringify(first.body).includes("refresh-"));

  r = await req(`/zoho/phonebridge/connect?orgId=${first.body.orgId}`, { headers: ADMIN });
  const st = new URL(r.headers.get("location")).searchParams.get("state");
  check("re-authorizing an existing org keeps its id", auth.readOAuthState(st) === first.body.orgId);
  return first.body.orgId;
}

async function testRegistration(orgId) {
  console.log("\n[5] Zoho user → Vobiz agent mapping and per-user registration");
  received.length = 0;
  const r = await postJson("/zoho/phonebridge/register", { orgId }, ADMIN);
  const body = await r.json();
  check("registration succeeds", r.status === 200 && body.registered === true, body);
  check("integrate is called first", received[0] && received[0].path === "/phonebridge/v3/integrate", received.map(x => x.path));
  const regs = received.filter(x => x.path === "/phonebridge/v3/clicktodial");
  check("one click-to-dial registration per mapped user", regs.length === 2, regs.map(x => x.fields));
  check("matched by explicit zohoUser", regs.some(x => x.fields.zohouser === "600001" && x.fields.clicktodialuri.includes("agentId=priya")));
  check("matched by email, case-insensitively", regs.some(x => x.fields.zohouser === "600002" && x.fields.clicktodialuri.includes("agentId=arjun")));
  check("each registered URI carries a click-to-dial token", regs.every(x => /[?&]t=/.test(x.fields.clicktodialuri)));
  check("unmatched agents and users are reported", body.unmatchedAgents.includes("nomatch") && body.unmatchedZohoUsers.some(u => u.zohouser === "600003"), body);
  check("the mapping is persisted on the org", JSON.stringify(pb.getOrg(orgId).agentMap) === JSON.stringify({ priya: "600001", arjun: "600002" }), pb.getOrg(orgId).agentMap);
  return Object.fromEntries(regs.map(x => [x.fields.zohouser, x.fields.clicktodialuri.replace("https://example.test", "")]));
}

async function agentCookie(agentId) {
  const s = await postJson("/agent-session", { agentId, key: auth.agentKey(agentId) });
  return (s.headers.get("set-cookie") || "").split(";")[0];
}

/** Opens an agent's event stream as softphone tab `tabId`. */
function openStream(cookie, tabId) {
  return new Promise(resolve => {
    const events = [];
    const r = http.get(`${B}/call-events?tab=${encodeURIComponent(tabId)}`, { headers: { Cookie: cookie } }, res => {
      res.on("data", chunk => {
        for (const line of String(chunk).split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
      });
      resolve({ events, close: () => r.destroy() });
    });
  });
}

/**
 * Signs the agent in (link, then Vobiz account or SIP direct) from softphone
 * tab `tabId` and opens that tab's event stream, the way the page does.
 */
async function openSoftphone(agentId, creds, tabId = `tab-${crypto.randomUUID()}`) {
  const cookie = await agentCookie(agentId);
  const route = creds.sipUser ? "/agent/sip-session" : "/agent/vobiz-session";
  const signin = await postJson(route, { ...creds, tabId }, { Cookie: cookie });
  const vobiz = await signin.json();
  const stream = await openStream(cookie, tabId);
  return { ...stream, cookie, vobiz, tabId, status: signin.status };
}

const ACCT1 = { authId: "MA_TEST0001", authToken: "tok-one-secret-value" };
const ACCT2 = { authId: "MA_TEST0002", authToken: "tok-two-secret-value" };
const sipUserOf = phone => phone.vobiz.sipUser.split("@")[0];
let priyaPhone = null;
let arjunPhone = null;
let recordingLink = null;

async function testClickToDial(orgId, uris) {
  console.log("\n[6] Click-to-dial → browser A leg → customer → call log");

  received.length = 0;
  vobizCalls = [];
  let r = await post(uris["600001"], { tonumber: "+910000900001" });
  let body = await r.json();
  check("with no softphone open the dial is refused, not attempted over REST", r.status === 409 && vobizCalls.length === 0, { status: r.status, vobizCalls });
  await waitFor(() => received.some(x => x.path === "/phonebridge/v3/clicktodialerror"));
  const err = received.find(x => x.path === "/phonebridge/v3/clicktodialerror");
  check("and Zoho is told why (clicktodialerror AGENT_OFFLINE)", err && err.fields.code === "AGENT_OFFLINE", err && err.fields);

  const phone = priyaPhone = await openSoftphone("priya", { ...ACCT1, callerId: "+910000000002" });
  check("priya signs in with Vobiz account MA_TEST0001", phone.status === 200 && phone.vobiz.authId === "MA_TEST0001" && Boolean(phone.vobiz.sipPassword), phone.vobiz);
  check("the caller ID list is every page of active, voice-enabled numbers", JSON.stringify(phone.vobiz.numbers.map(n => n.e164)) === JSON.stringify(["+910000000001", "+910000000002"]), phone.vobiz.numbers);
  check("each number says which application answers it", phone.vobiz.numbers.every(n => n.applicationId === OUR_APP_1));
  r = await postJson("/agent/caller-id", { callerId: "+910000000099" }, { Cookie: phone.cookie });
  check("a caller ID outside the account's list is rejected", r.status === 400);
  vobizCalls = [];
  await tick();
  received.length = 0;
  r = await post(uris["600001"], { tonumber: "+910000900001", zohouser: "600001" });
  body = await r.json();
  check("the click is accepted with a call id", r.status === 200 && /^vobiz-browser-/.test(body.callid), body);
  await waitFor(() => phone.events.some(e => e.type === "dial"));
  check("the number is handed to the softphone", phone.events.some(e => e.type === "dial" && e.to === "+910000900001"));
  check("no REST call was placed", vobizCalls.length === 0, vobizCalls);
  await waitFor(() => notifies().length >= 1);
  const ringing = notifies()[0];
  check("Zoho hears ringing for that user, without start_time", ringing && ringing.fields.state === "ringing" && ringing.fields.zohouser === "600001" && !("start_time" in ringing.fields), ringing && ringing.fields);
  check("the caller ID is the number the agent picked on their account", ringing && ringing.fields.from === "+910000000002", ringing && ringing.fields);

  // The browser's INVITE reaches Vobiz, which fetches the endpoint's answer URL.
  // No ?agentId= — the agent is recognised from the SIP username.
  const callUuid = "aleg-uuid-1";
  r = await post("/answer", { CallUUID: callUuid, From: `sip:${sipUserOf(phone)}@registrar.vobiz.ai`, To: "910000900001", Direction: "inbound" });
  const xml = await r.text();
  check("/answer dials the customer with <Dial><Number>", /<Dial[^>]*>\s*<Number>910000900001<\/Number>/.test(xml), xml);
  check("with the agent's caller ID", xml.includes('callerId="+910000000002"'), xml);
  check("never with <Dial><User>", !xml.includes("<User>"));
  check("and a callbackUrl to see the customer answer, naming the account", xml.includes("/dial-event?agentId=priya&amp;authId=MA_TEST0001"), xml);
  check("the answer is well-formed XML: every & is escaped (else Vobiz rejects it as Invalid Answer XML and the call fails Busy)",
    !/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/.test(xml), xml);

  received.length = 0;
  await post("/dial-event?agentId=priya&authId=MA_TEST0001", { Event: "DialAnswer", DialAction: "answer", CallUUID: callUuid, DialBLegUUID: "bleg-uuid-1" });
  await post("/dial-event?agentId=priya&authId=MA_TEST0001", { Event: "DialAnswer", DialAction: "answer", CallUUID: callUuid, DialBLegUUID: "bleg-uuid-1" });
  await waitFor(() => notifies().length >= 1);
  await tick();
  check("answered is reported exactly once", notifies().filter(n => n.fields.state === "answered").length === 1, notifies().map(n => n.fields.state));

  r = await post("/dial-result?agentId=priya&authId=MA_TEST0001", { CallUUID: callUuid, DialStatus: "completed", DialBLegUUID: "bleg-uuid-1" });
  check("dial-result answers an empty <Response>", /<Response><\/Response>/.test(await r.text()));

  received.length = 0;
  await post("/recording-ready?agentId=priya&authId=MA_TEST0001", { Event: "RecordStop", CallUUID: callUuid, RecordingID: "rec-1", RecordingDuration: "30" });
  await waitFor(() => notifies().length >= 1);
  const ended = notifies()[0];
  check("the call log lands with the recording (browser-originated calls used to lose it)", ended && ended.fields.state === "ended" && Boolean(ended.fields.voiceuri), ended && ended.fields);
  check("duration is the customer leg's billed time", ended && ended.fields.duration === "37", ended && ended.fields);
  check("ended carries a GMT start_time", ended && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ended.fields.start_time));
  check("the recording link carries no Vobiz token, and names its account", ended && !ended.fields.voiceuri.includes("tok-") && ended.fields.voiceuri.includes("authId=MA_TEST0001"), ended && ended.fields.voiceuri);

  const link = recordingLink = ended.fields.voiceuri.replace("https://example.test", "");
  vobizCalls = [];
  r = await req(link);
  check("the signed recording link streams audio", r.status === 200 && (r.headers.get("content-type") || "").includes("audio"), r.status);
  check("fetched with that account's credentials only", vobizCalls.length > 0 && vobizCalls.every(c => c.headers["X-Auth-ID"] === "MA_TEST0001" && c.headers["X-Auth-Token"] === "tok-one-secret-value"), vobizCalls.map(c => c.headers["X-Auth-ID"]));
  r = await req(link.replace(/sig=[0-9a-f]+/, "sig=" + "0".repeat(64)));
  check("a bad signature is 403", r.status === 403);
  recordingUrlForStub = "https://example.com/";
  r = await req(link);
  check("a recording URL off vobiz.ai is never fetched with credentials", r.status === 404 && !vobizCalls.some(c => c.target.startsWith("https://example.com")));
  recordingUrlForStub = "https://media.vobiz.ai/recordings/rec-1.mp3";

  // Zoho says another mapped user clicked a URI registered for priya: route to that user's agent.
  arjunPhone = await openSoftphone("arjun", ACCT2);
  check("arjun signs in with a different account, MA_TEST0002", arjunPhone.status === 200 && arjunPhone.vobiz.authId === "MA_TEST0002", arjunPhone.vobiz);
  await tick();
  r = await post(uris["600001"], { tonumber: "+910000900002", zohouser: "600002" });
  await waitFor(() => arjunPhone.events.some(e => e.type === "dial"));
  check("the clicking Zoho user's mapped agent gets the call", arjunPhone.events.some(e => e.type === "dial" && e.to === "+910000900002"));
  phone.close();
  arjunPhone.close();
}

async function testInbound(orgId) {
  console.log("\n[7] Inbound — routed by the dialled DID to that account's signed-in agents");
  received.length = 0;
  let r = await post("/answer", { CallUUID: "in-uuid-1", From: "910008000000", To: "910000000001" });
  let xml = await r.text();
  check("a call to MA_TEST0001's DID rings priya's provisioned endpoint", xml.includes(`<User>sip:${sipUserOf(priyaPhone)}@registrar.vobiz.ai</User>`), xml);
  check("and not the other account's agent", !xml.includes(sipUserOf(arjunPhone)));
  check("the <Dial> carries callerId = the DID", xml.includes('callerId="+910000000001"'), xml);
  check("rings for 20 seconds, as documented", xml.includes('timeout="20"'));
  check("the inbound answer is well-formed XML too: every & in its callback URLs is escaped",
    !/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/.test(xml) && xml.includes("&amp;dir=in"), xml);
  check("then voicemail", xml.includes("leave a message"));
  await waitFor(() => notifies().length >= 1);
  const ring = notifies()[0];
  check("Zoho hears a received/ringing call for the mapped user", ring && ring.fields.type === "received" && ring.fields.zohouser === "600001" && ring.fields.from === "+910008000000", ring && ring.fields);

  received.length = 0;
  await finalizeZohoPhoneBridgeCall("in-uuid-1");
  const ended = notifies()[0];
  check("an unanswered inbound call is logged as ended/0s, accepted by Zoho", ended && ended.fields.state === "ended" && ended.fields.duration === "0", ended && ended.fields);

  r = await post("/answer", { CallUUID: "in-uuid-2", From: "910008000000", To: "910000000003" });
  xml = await r.text();
  check("a call to MA_TEST0002's DID rings arjun, not priya", xml.includes(sipUserOf(arjunPhone)) && !xml.includes(sipUserOf(priyaPhone)), xml);

  r = await post("/inbound-answer?agentId=priya", { CallUUID: "in-uuid-3", From: "910008000000", To: "910000000003" });
  xml = await r.text();
  check("the old /inbound-answer routes by DID too, ignoring ?agentId=", xml.includes(sipUserOf(arjunPhone)) && !xml.includes(sipUserOf(priyaPhone)), xml);

  r = await post("/answer", { CallUUID: "in-uuid-4", From: "910008000000", To: "910000000077" });
  xml = await r.text();
  check("a DID no signed-in account owns gets a polite hangup", xml.includes("<Hangup/>") && !xml.includes("<Dial"), xml);

  const hang = await post("/inbound-answer?agentId=priya", { Event: "Hangup", CallUUID: "in-uuid-1" });
  check("a Hangup event is acknowledged, not answered with <Dial>", !(await hang.text()).includes("<Dial"));
}

async function testCallbackContract() {
  console.log("\n[8] Callback contract and the missed state");
  let r = await post("/answer", { CallUUID: "x", From: "+911", To: "+912" });
  check("/answer for no known agent or DID hangs up politely instead of crashing", /<Hangup\/>/.test(await r.text()));
  r = await post("/answer", { CallUUID: "x", From: "sip:nobody@registrar.vobiz.ai", To: "+912" });
  check("/answer from an unknown SIP user says it cannot connect", (await r.text()).includes("cannot be connected"));
  r = await post("/answer?agentId=priya", { CallUUID: "x", Event: "Hangup" });
  check("/answer acknowledges Hangup with an empty document", /<Response><\/Response>/.test(await r.text()));

  received.length = 0;
  const credentials = { clientId: "x", clientSecret: "y" };
  const orgId = pb.listOrgs()[0].orgId;
  const bare = await pb.notifyCall({ orgId, type: "received", state: "missed", callId: "m1", from: "+1", to: "+2", credentials });
  check("missed now carries its mandatory start_time and is accepted", bare.ok && /\d{4}-\d{2}-\d{2} /.test(received[0].fields.start_time), received[0] && received[0].fields);
  check("missed carries no duration", !("duration" in received[0].fields));

  const nonce = "abc123";
  const sig = crypto.createHmac("sha256", "tok-one-secret-value").update(`https://example.test/answer.${nonce}`).digest("base64");
  const fake = h => ({ headers: h });
  const u = new URL("https://x/answer?agentId=priya");
  check("a correct X-Vobiz-Signature-V3 verifies (query string excluded)", verifyVobizSignature(fake({ "x-vobiz-signature-v3": sig, "x-vobiz-signature-v3-nonce": nonce }), u, "tok-one-secret-value"));
  check("a wrong one does not", !verifyVobizSignature(fake({ "x-vobiz-signature-v3": sig, "x-vobiz-signature-v3-nonce": "other" }), u, "tok-one-secret-value"));
  check("nor does the right one checked against another account's token", !verifyVobizSignature(fake({ "x-vobiz-signature-v3": sig, "x-vobiz-signature-v3-nonce": nonce }), u, "tok-two-secret-value"));
}

async function testAnyAccount(orgId) {
  console.log("\n[11] Any Vobiz account — sign-in, provisioning, routing, isolation");
  const disk = fs.readFileSync(vobizAccounts.storeFile(), "utf8");
  const store = JSON.parse(disk);
  const e1 = store["MA_TEST0001:priya"];
  const e2 = store["MA_TEST0002:arjun"];
  check("two accounts get two distinct endpoints", e1 && e2 && e1.endpointId !== e2.endpointId && e1.username !== e2.username, store);
  check("the stored username is the one Vobiz rewrote, read back by GET", e1.username === sipUserOf(priyaPhone) && e1.username.endsWith(e1.endpointId));
  check("the endpoint store is 0600", (fs.statSync(vobizAccounts.storeFile()).mode & 0o777) === 0o600);
  check("and holds no password or token", !disk.includes(priyaPhone.vobiz.sipPassword) && !disk.includes("tok-") && !/password|token/i.test(disk), disk);
  check("an existing application with our answer_url is reused, none created in MA_TEST0001", vobizState.MA_TEST0001.apps.length === 2);
  check("account 2 got one application, answer_url and hangup_url on this backend", vobizState.MA_TEST0002.apps.length === 1 && vobizState.MA_TEST0002.apps[0].answer_url === "https://example.test/answer" && vobizState.MA_TEST0002.apps[0].hangup_url === "https://example.test/hangup", vobizState.MA_TEST0002.apps);
  check("each endpoint is bound to its own account's application, 17-digit id intact",
    vobizState.MA_TEST0001.endpoints[e1.endpointId].app === OUR_APP_1 && vobizState.MA_TEST0002.endpoints[e2.endpointId].app === NEW_APP_2);

  // Re-sign-in: same endpoint, fresh password, exact bind bodies on the wire.
  // Unbind it first, as if someone had changed it in the console.
  vobizState.MA_TEST0001.endpoints[e1.endpointId].app = null;
  // +910000000002 answers on someone else's application, by name.
  vobizState.MA_TEST0001.numberApps = { "+910000000002": "11111111111111111" };
  vobizCalls = [];
  const before = vobizState.MA_TEST0001.endpoints[e1.endpointId].password;
  const cookie = await agentCookie("priya");
  let r = await postJson("/agent/vobiz-session", ACCT1, { Cookie: cookie });
  let body = await r.json();
  check("signing in again remembers the agent's caller ID choice", body.callerId === "+910000000002", body.callerId);
  const n2 = body.numbers.find(n => n.e164 === "+910000000002");
  check("each number carries the name of the application answering it", n2 && n2.applicationName === "someone-elses" && n2.applicationId === "11111111111111111", body.numbers);
  check("signing in again reuses the endpoint", r.status === 200 && body.sipUser.startsWith(e1.username + "@") && Object.keys(vobizState.MA_TEST0001.endpoints).length === 1, body);
  check("with a fresh SIP password", body.sipPassword && body.sipPassword !== before && vobizState.MA_TEST0001.endpoints[e1.endpointId].password === body.sipPassword);
  const binds = vobizCalls.filter(c => c.method === "POST" && /\/Endpoint\/\d+\/$/.test(c.target) && /app/.test(c.body)).map(c => c.body);
  check('bind tries {"app_id":"43919358318796814"} first', binds[0] === '{"app_id":"43919358318796814"}', binds);
  check('then the documented {"application":43919358318796814}, digit for digit', binds[1] === '{"application":43919358318796814}', binds);
  check("never an application it did not create", !vobizCalls.some(c => c.body.includes("11111111111111111")));
  check("the sign-in reply carries no Auth Token", !JSON.stringify(body).includes("tok-"));

  r = await postJson("/agent/vobiz-session", { authId: "MA_TEST0001", authToken: "wrong-token" }, { Cookie: await agentCookie("nomatch") });
  body = await r.json();
  check("a wrong token is refused with 401 and a clear message", r.status === 401 && /did not accept/.test(body.error), body);
  check("and signs nobody in", vobizAccounts.sessionFor("nomatch") === null);
  r = await postJson("/agent/vobiz-session", ACCT1);
  check("Vobiz sign-in without the agent link cookie is 401", r.status === 401);

  // The webhook signature is checked with the right account's token.
  process.env.REQUIRE_VOBIZ_SIGNATURE = "true";
  const nonce = "n-1";
  const sign = tok => ({ "X-Vobiz-Signature-V3": crypto.createHmac("sha256", tok).update(`https://example.test/answer.${nonce}`).digest("base64"), "X-Vobiz-Signature-V3-Nonce": nonce });
  const from = { CallUUID: "sig-1", From: `sip:${e1.username}@registrar.vobiz.ai`, To: "910000900009" };
  r = await post("/answer", from, sign("tok-two-secret-value"));
  check("a webhook for MA_TEST0001 signed with MA_TEST0002's token is refused", /<Hangup\/>/.test(await r.text()));
  r = await post("/answer", from, sign("tok-one-secret-value"));
  check("signed with MA_TEST0001's own token it is accepted", /<Number>910000900009<\/Number>/.test(await r.text()));
  process.env.REQUIRE_VOBIZ_SIGNATURE = "false";

  // Outbound caller ID: X-VH-Caller-ID, only a number of that account.
  r = await post("/answer", { ...from, "X-VH-Caller-ID": "+910000000001" });
  check("X-VH-Caller-ID picks the caller ID for the call", (await r.text()).includes('callerId="+910000000001"'));
  r = await post("/answer", { ...from, "SIPHeader_X-VH-Caller-ID": "+910000000003" });
  check("one from another account's numbers is ignored", (await r.text()).includes('callerId="+910000000002"'));

  // Inbound by ParentAuthID.
  r = await post("/answer", { CallUUID: "in-p-1", From: "910008000000", To: "00000000066", Direction: "inbound", ParentAuthID: "MA_TEST0002" });
  let xml = await r.text();
  check("ParentAuthID picks the account's agents for inbound", xml.includes(`<User>sip:${e2.username}@registrar.vobiz.ai</User>`) && !xml.includes(e1.username), xml);
  check("callerId is the dialled To in E.164 (0XXXXXXXXXX -> +91XXXXXXXXXX)", xml.includes('callerId="+910000000066"'), xml);

  // Enable inbound calls: explicit, account's own numbers only.
  vobizCalls = [];
  r = await postJson("/agent/enable-inbound", { number: "+910000000002" }, { Cookie: cookie });
  body = await r.json();
  const attach = vobizCalls.find(c => c.target.includes("/numbers/%2B910000000002/application"));
  check("Enable inbound attaches the DID to our application", r.status === 200 && attach && attach.body === '{"application_id":"43919358318796814"}', attach);
  check("and reports which application it moved from, by name and ID", body.previousApplicationId === "11111111111111111" && body.previousApplicationName === "someone-elses", body);
  r = await postJson("/agent/enable-inbound", { number: "+910000000003" }, { Cookie: cookie });
  check("another account's number is refused", r.status === 400);

  // Recording links are scoped to their account.
  r = await req(recordingLink.replace("authId=MA_TEST0001", "authId=MA_TEST0002"));
  check("a recording link moved to another account fails its signature", r.status === 403, r.status);

  // SIP direct.
  const sipPhone = await openSoftphone("nomatch", { sipUser: "custsip01", callerId: "+91 00000 00009" });
  check("SIP direct sign-in takes a username and caller ID, no password", sipPhone.status === 200 && sipPhone.vobiz.callerId === "+910000000009" && !("sipPassword" in sipPhone.vobiz), sipPhone.vobiz);
  r = await postJson("/agent/sip-session", { sipUser: "custsip01", callerId: "not-a-number" }, { Cookie: sipPhone.cookie });
  check("a bad caller ID is refused", r.status === 400);
  await tick();
  const uri = `/zoho/phonebridge/clicktodial?orgId=${orgId}&agentId=nomatch&t=${auth.clickToDialToken(orgId, "nomatch")}`;
  received.length = 0;
  r = await post(uri, { tonumber: "+910000900003" });
  check("Zoho click-to-dial works for a SIP-direct agent", r.status === 200, await r.text());
  await waitFor(() => sipPhone.events.some(e => e.type === "dial"));
  check("the number reaches that softphone", sipPhone.events.some(e => e.type === "dial" && e.to === "+910000900003"));
  r = await post("/answer", { CallUUID: "sip-1", From: "sip:custsip01@registrar.vobiz.ai", To: "910000900003" });
  xml = await r.text();
  check("its /answer dials with the typed caller ID", xml.includes('callerId="+910000000009"') && xml.includes("<Number>910000900003</Number>"), xml);
  r = await post("/answer", { CallUUID: "sip-in-1", From: "910008000000", To: "910000000009" });
  check("inbound to its caller ID rings it", (await r.text()).includes("<User>sip:custsip01@registrar.vobiz.ai</User>"));
  r = await postJson("/agent/enable-inbound", { number: "+910000000009" }, { Cookie: sipPhone.cookie });
  body = await r.json();
  check("account-only features say to sign in with a Vobiz account", r.status === 400 && /sign in with your Vobiz account/.test(body.error), body);
  sipPhone.close();

  r = await req("/zoho/phonebridge/status", { headers: ADMIN });
  body = await r.json();
  check("admin status lists signed-in accounts by id only", body.vobizAccounts.some(a => a.authId === "MA_TEST0001") && !JSON.stringify(body).includes("tok-"), body.vobizAccounts);

  r = await post(uri.replace("agentId=nomatch", "agentId=priya").replace(/t=[^&]+/, `t=${auth.clickToDialToken(orgId, "priya")}`), { tonumber: "+910000900004" });
  check("an agent signed in but with no softphone open is still AGENT_OFFLINE", r.status === 409);

  check("no Auth Token appears in any HTTP response", !seenResponses.some(t => t.includes("tok-one-secret-value") || t.includes("tok-two-secret-value")));
}


const sipFrom = phone => `sip:${sipUserOf(phone)}@registrar.vobiz.ai`;

async function testOutboundRecordSetting() {
  console.log("\n[12] OUTBOUND_RECORD — the outbound recording setting");
  const from = `sip:${vobizAccounts.sessionFor("priya").sipUser}@registrar.vobiz.ai`;
  let xml = await (await post("/answer", { CallUUID: "rec-default", From: from, To: "910000900050" })).text();
  check("by default the outbound call is recorded (<Record> before <Dial>)", /<Record recordSession="true"[^>]*\/>\s*<Dial/.test(xml), xml);
  process.env.OUTBOUND_RECORD = "false";
  xml = await (await post("/answer", { CallUUID: "rec-off", From: from, To: "910000900051" })).text();
  check("OUTBOUND_RECORD=false dials without <Record>", !xml.includes("<Record") && /<Number>910000900051<\/Number>/.test(xml), xml);
  process.env.OUTBOUND_RECORD = "true";
  xml = await (await post("/answer", { CallUUID: "rec-on", From: from, To: "910000900052" })).text();
  check("OUTBOUND_RECORD=true records", xml.includes("<Record recordSession"), xml);
  delete process.env.OUTBOUND_RECORD;
  for (const id of ["rec-default", "rec-off", "rec-on"]) pb.untrackCall(id);
}

async function testTabsAndManualDials(orgId, uris) {
  console.log("\n[13] One phone line per agent — the newest sign-in takes it, the other tabs are told");
  const elsewhere = phone => phone.events.filter(e => e.type === "signed-in-elsewhere").length;
  const tabA = await openSoftphone("priya", ACCT1, "tab-aaaaaaaa-0001");
  await tick();
  const epId = JSON.parse(fs.readFileSync(vobizAccounts.storeFile(), "utf8"))["MA_TEST0001:priya"].endpointId;
  const tabB = await openSoftphone("priya", ACCT1, "tab-bbbbbbbb-0002");
  check("a second tab's sign-in gets a new SIP password", tabB.status === 200 && Boolean(tabB.vobiz.sipPassword) && tabB.vobiz.sipPassword !== tabA.vobiz.sipPassword);
  check("on the same endpoint (one per agent and account)", tabB.vobiz.sipUser === tabA.vobiz.sipUser, [tabA.vobiz.sipUser, tabB.vobiz.sipUser]);
  check("and the new password is the endpoint's, so the first tab's can no longer register", vobizState.MA_TEST0001.endpoints[epId].password === tabB.vobiz.sipPassword);
  check("the reply to the second tab is still free of the Auth Token", !JSON.stringify(tabB.vobiz).includes("tok-"));
  await waitFor(() => elsewhere(tabA) >= 1);
  check("the first tab is told it was signed in elsewhere", elsewhere(tabA) === 1, tabA.events);
  // The second tab signs in again with its stream open: only the other tab hears of it.
  let r = await postJson("/agent/vobiz-session", { ...ACCT1, tabId: tabB.tabId }, { Cookie: tabB.cookie });
  tabB.vobiz = await r.json();
  await waitFor(() => elsewhere(tabA) >= 2);
  await tick();
  check("a sign-in tells the agent's other tabs, never the tab that signed in", elsewhere(tabA) === 2 && elsewhere(tabB) === 0, { a: elsewhere(tabA), b: elsewhere(tabB) });

  r = await post(uris["600001"], { tonumber: "+910000900061", zohouser: "600001" });
  check("click-to-dial is accepted", r.status === 200);
  await waitFor(() => tabB.events.some(e => e.type === "dial"));
  await tick();
  check("click-to-dial goes to the tab holding the line only", tabB.events.some(e => e.type === "dial" && e.to === "+910000900061") && !tabA.events.some(e => e.type === "dial"));
  check("the other tab is told the call went to the other tab", tabA.events.some(e => e.type === "dial-elsewhere" && e.to === "+910000900061"), tabA.events);

  console.log("\n[14] Manual dials are logged in Zoho");
  // The pending click is for +910000900061; the agent types another number first.
  received.length = 0;
  let xml = await (await post("/answer", { CallUUID: "manual-1", From: sipFrom(tabB), To: "910000900077" })).text();
  check("a typed number is dialled as usual", /<Number>910000900077<\/Number>/.test(xml), xml);
  await waitFor(() => notifies().length >= 1);
  let ring = notifies()[0];
  check("Zoho hears dialed/ringing for the agent's Zoho user", ring && ring.fields.type === "dialed" && ring.fields.state === "ringing" && ring.fields.zohouser === "600001" && ring.fields.to === "+910000900077" && ring.fields.from === "+910000000002", ring && ring.fields);
  check("under its own call id, not the pending click-to-dial's", ring && ring.fields.id === "vobiz-manual-manual-1", ring && ring.fields.id);
  received.length = 0;
  await post("/dial-event?agentId=priya&authId=MA_TEST0001", { Event: "DialAnswer", DialAction: "answer", CallUUID: "manual-1", DialBLegUUID: "bleg-manual-1" });
  await waitFor(() => notifies().length >= 1);
  check("then answered", notifies().some(n => n.fields.state === "answered" && n.fields.id === "vobiz-manual-manual-1"));
  received.length = 0;
  await post("/recording-ready?agentId=priya&authId=MA_TEST0001", { CallUUID: "manual-1", RecordingID: "rec-m1", RecordingDuration: "12" });
  await waitFor(() => notifies().length >= 1);
  const ended = notifies()[0];
  check("and ended, with duration and recording, as the call log", ended && ended.fields.state === "ended" && ended.fields.id === "vobiz-manual-manual-1" && ended.fields.duration === "37" && Boolean(ended.fields.voiceuri) && ended.fields.zohouser === "600001", ended && ended.fields);

  received.length = 0;
  xml = await (await post("/answer", { CallUUID: "c2d-1", From: sipFrom(tabB), To: "910000900061" })).text();
  await waitFor(() => notifies().length >= 1);
  await tick();
  check("the call to the clicked number still binds to the click-to-dial call id (no duplicate ringing)", pb.getTrackedCall("c2d-1") && /^vobiz-browser-/.test(pb.getTrackedCall("c2d-1").callId) && notifies().length === 0, { tracked: pb.getTrackedCall("c2d-1"), n: notifies().map(n => n.fields) });
  pb.untrackCall("c2d-1");

  received.length = 0;
  await post("/answer", { CallUUID: "manual-sip", From: "sip:custsip01@registrar.vobiz.ai", To: "910000900078" });
  await tick(150);
  check("a manual dial by an agent with no Zoho user is not logged", notifies().length === 0 && !pb.getTrackedCall("manual-sip"), notifies().map(n => n.fields));

  // The first tab's stream reconnects, so it is now the most recent one.
  tabA.close();
  await tick(100);
  const tabA2 = await openStream(tabA.cookie, tabA.tabId);
  await tick();
  r = await post(uris["600001"], { tonumber: "+910000900062", zohouser: "600001" });
  const click = await r.json();
  await waitFor(() => tabB.events.some(e => e.type === "dial" && e.to === "+910000900062"));
  check("a click still goes to the tab holding the line, not the most recently connected one",
    tabB.events.some(e => e.type === "dial" && e.to === "+910000900062") && !tabA2.events.some(e => e.type === "dial"), tabA2.events);
  await postJson("/agent/call-failed", { callId: click.callid, cause: "test cleanup" }, { Cookie: tabB.cookie });
  await waitFor(() => notifies().some(n => n.fields.id === click.callid && n.fields.state === "ended"));

  tabB.close();
  await tick(200);
  received.length = 0;
  r = await post(uris["600001"], { tonumber: "+910000900063", zohouser: "600001" });
  check("with the line's tab closed, a click is AGENT_OFFLINE — never handed to a tab that lost the line",
    r.status === 409 && !tabA2.events.some(e => e.type === "dial"), r.status);
  r = await postJson("/agent/vobiz-session", { ...ACCT1, tabId: tabA.tabId }, { Cookie: tabA.cookie });
  const again = await r.json();
  check("signing in there again rotates the SIP password once more",
    r.status === 200 && again.sipPassword !== tabB.vobiz.sipPassword && vobizState.MA_TEST0001.endpoints[epId].password === again.sipPassword);
  r = await post(uris["600001"], { tonumber: "+910000900064", zohouser: "600001" });
  const click2 = await r.json();
  await waitFor(() => tabA2.events.some(e => e.type === "dial"));
  check("and the line, with click-to-dial, is back in that tab", tabA2.events.some(e => e.type === "dial" && e.to === "+910000900064"), tabA2.events);
  await postJson("/agent/call-failed", { callId: click2.callid, cause: "test cleanup" }, { Cookie: tabA.cookie });
  await waitFor(() => notifies().some(n => n.fields.id === click2.callid && n.fields.state === "ended"));
  tabA2.close();
  await tick(100);
}

async function testInboundAnswerer() {
  console.log("\n[15] Inbound — the call log goes to the agent who answered");
  const arjun = await openSoftphone("arjun", ACCT1);
  const priyaUser = vobizAccounts.sessionFor("priya").sipUser;
  const arjunUser = sipUserOf(arjun);
  check("arjun signs in to MA_TEST0001 too", arjun.status === 200 && vobizAccounts.sessionFor("arjun").authId === "MA_TEST0001");

  received.length = 0;
  const xml = await (await post("/answer", { CallUUID: "in-ans-1", From: "910008000001", To: "910000000001" })).text();
  check("the call rings both agents", xml.includes(`<User>sip:${priyaUser}@`) && xml.includes(`<User>sip:${arjunUser}@`), xml);
  await waitFor(() => notifies().length >= 1);
  check("ringing goes to the first mapped ringing agent (priya)", notifies()[0].fields.zohouser === "600001", notifies()[0].fields);
  received.length = 0;
  await post("/dial-event?agentId=priya&authId=MA_TEST0001&dir=in", { Event: "DialAnswer", DialAction: "answer", CallUUID: "in-ans-1", DialBLegUUID: "bleg-in-1", DialBLegTo: `sip:${arjunUser}@registrar.vobiz.ai` });
  await waitFor(() => notifies().length >= 1);
  check("answered is reported for the agent Vobiz names in DialBLegTo (arjun)", notifies()[0].fields.state === "answered" && notifies()[0].fields.zohouser === "600002", notifies()[0].fields);
  received.length = 0;
  await post("/recording-ready?agentId=priya&authId=MA_TEST0001&dir=in", { CallUUID: "in-ans-1", RecordingID: "rec-in-1" });
  await waitFor(() => notifies().length >= 1);
  check("the call log lands on arjun, who answered", notifies()[0].fields.state === "ended" && notifies()[0].fields.zohouser === "600002" && notifies()[0].fields.type === "received", notifies()[0].fields);

  // No DialBLegTo: the softphone's own report decides.
  await post("/answer", { CallUUID: "in-ans-2", From: "910008000002", To: "910000000001" });
  await waitFor(() => Boolean(pb.getTrackedCall("in-ans-2")));
  let r = await postJson("/agent/inbound-answered", { callUuid: "in-ans-2" }, { Cookie: await agentCookie("nomatch") });
  check("an agent who was not rung cannot claim the call", r.status === 404);
  r = await postJson("/agent/inbound-answered", { callUuid: "in-ans-2" });
  check("claiming needs the agent session", r.status === 401);
  r = await postJson("/agent/inbound-answered", { callUuid: "in-ans-2" }, { Cookie: arjun.cookie });
  check("the softphone that accepted reports it", r.status === 200 && (await r.json()).logged === true);
  r = await postJson("/agent/inbound-answered", { callUuid: "in-ans-2" }, { Cookie: await agentCookie("priya") });
  check("a second claim by another agent does not move it", r.status === 404);
  received.length = 0;
  await post("/dial-event?agentId=priya&authId=MA_TEST0001&dir=in", { Event: "DialAnswer", DialAction: "answer", CallUUID: "in-ans-2", DialBLegUUID: "bleg-in-2" });
  await waitFor(() => notifies().some(n => n.fields.state === "answered"));
  await finalizeZohoPhoneBridgeCall("in-ans-2");
  const end2 = notifies().find(n => n.fields.state === "ended");
  check("the call log lands on the agent the softphone reported", end2 && end2.fields.zohouser === "600002", end2 && end2.fields);

  // Nobody answers: logged against the first mapped ringing agent.
  received.length = 0;
  await post("/answer", { CallUUID: "in-ans-3", From: "910008000003", To: "910000000001" });
  await waitFor(() => notifies().length >= 1);
  received.length = 0;
  await finalizeZohoPhoneBridgeCall("in-ans-3");
  check("a missed inbound call is logged against the first mapped ringing agent", notifies()[0] && notifies()[0].fields.zohouser === "600001" && notifies()[0].fields.duration === "0", notifies()[0] && notifies()[0].fields);
  arjun.close();
}

async function testMicrophonePrompt() {
  console.log("\n[16] Softphone asks for the microphone at sign-in");
  const html = await (await req("/agent-phone")).text();
  const calls = html.match(/startPhone\([^)]*\);\s*requestMicrophone\(\);/g) || [];
  check("both sign-in paths request the microphone right after starting the phone", calls.length === 2, calls);
  check("the request stops the tracks again, keeping only the permission", /getUserMedia\(\{ audio: true[^}]*\}\);\s*stream\.getTracks\(\)\.forEach\(t => t\.stop\(\)\)/.test(html));
  check("a denied microphone is named in the status", html.includes("Microphone blocked"));
  check("Enable inbound names the application, ID as fallback", html.includes("info.applicationName, info.applicationId"));
}

async function testDisconnect(orgId) {
  console.log("\n[9] Disconnect — deregister, revoke, delete");
  received.length = 0;
  const r = await postJson("/zoho/phonebridge/disconnect", { orgId }, ADMIN);
  check("disconnect succeeds", r.status === 200);
  check("each per-user registration is removed", received.filter(x => x.path === "/phonebridge/v3/clicktodial" && x.method === "DELETE").length === 2);
  check("the refresh token is revoked at Zoho", received.some(x => x.path === "/oauth/v2/token/revoke"));
  check("our copy is deleted", pb.getOrg(orgId) === null);
}

async function testNoAgentsFile() {
  console.log("\n[10] A missing agents.json does not take the process down");
  const saved = fs.readFileSync(AGENTS_FILE);
  fs.unlinkSync(AGENTS_FILE);
  const r = await req("/agent/priya");
  const h = await req("/health");
  fs.writeFileSync(AGENTS_FILE, saved);
  check("GET /agent/... answers instead of crashing", r.status === 401);
  check("and the server is still up", h.status === 200);
}

async function testMalformedRequests() {
  console.log("\n[17] A malformed request never takes the process down");
  const raw = (p, init = {}) => realFetch(`${B}${p}`, { redirect: "manual", ...init });
  let r = await raw("/agent/%zz");
  check("GET /agent/%zz is a 400, not a crash", r.status === 400, r.status);
  r = await raw("/call-events/%E0%A4");
  check("GET /call-events/%E0%A4 is a 400", r.status === 400, r.status);
  r = await raw("/admin/agent-links", { headers: { Cookie: "vz_admin=%E0%A4; _ga=50%" } });
  check("a malformed admin cookie is simply no session (401)", r.status === 401, r.status);
  r = await raw("/call-events", { headers: { Cookie: "vz_agent=%" } });
  check("a malformed agent cookie on the event stream is 401", r.status === 401, r.status);
  r = await raw("/agent-logout", { method: "POST", headers: { Cookie: "theme=%E0" } });
  check("signing out with a malformed cookie still answers", r.status === 200, r.status);
  const good = await agentCookie("priya");
  r = await raw("/agent/me", { headers: { Cookie: `_ga=50%; ${good}` } });
  check("another app's malformed cookie on the same host does not sign the agent out", r.status === 200, r.status);

  // A handler that throws, or rejects, costs that one request a 500.
  routes["GET /__test-throws"] = () => { throw new Error("thrown on purpose by test [17]"); };
  routes["GET /__test-rejects"] = async () => { throw new Error("rejected on purpose by test [17]"); };
  r = await raw("/__test-throws");
  check("a handler that throws is answered with a 500", r.status === 500, r.status);
  r = await raw("/__test-rejects");
  check("so is one that rejects", r.status === 500, r.status);
  delete routes["GET /__test-throws"];
  delete routes["GET /__test-rejects"];
  r = await raw("/health");
  check("and the server is still up", r.status === 200 && (await r.text()) === "ok");
}

async function testSoftphoneHardening(uris) {
  console.log("\n[18] The softphone shows caller data as text, under a strict Content-Security-Policy");
  const r = await req("/agent-phone");
  const html = await r.text();
  const csp = r.headers.get("content-security-policy") || "";
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const hash = inline.length === 1 ? crypto.createHash("sha256").update(inline[0], "utf8").digest("base64") : null;
  check("the softphone is served with a Content-Security-Policy", csp.startsWith("default-src 'none'"), csp);
  check("scripts: this origin and the page's own script, pinned by hash — no 'unsafe-inline'",
    Boolean(hash) && csp.includes(`script-src 'self' 'sha256-${hash}'`) && !/script-src[^;]*unsafe/.test(csp), csp);
  check("network: only this backend and the Vobiz registrar", /(^|; )connect-src 'self' wss:\/\/registrar\.vobiz\.ai:5063(;|$)/.test(csp), csp);
  check("the activity log is built from text, never parsed as HTML", !/insertAdjacentHTML|innerHTML|outerHTML|document\.write/.test(html));

  const phone = await openSoftphone("priya", ACCT1);
  await tick();
  await post("/answer", { CallUUID: "xss-in-1", From: "910008000009", To: "910000000001", CallerName: '<img src=x onerror="alert(1)">Evil' });
  await waitFor(() => phone.events.some(e => e.type === "inbound-routed"));
  const ev = phone.events.find(e => e.type === "inbound-routed");
  check("a caller name carrying markup never reaches the softphone — the number is shown instead", ev && ev.from === "+910008000009", ev);
  await post("/answer", { CallUUID: "plain-in-1", From: "910008000010", To: "910000000001", CallerName: "Priya's Bakery" });
  await waitFor(() => phone.events.filter(e => e.type === "inbound-routed").length >= 2);
  const ev2 = phone.events.filter(e => e.type === "inbound-routed")[1];
  check("a plain caller name still is", ev2 && ev2.from === "Priya's Bakery", ev2);
  for (const id of ["xss-in-1", "plain-in-1"]) pb.untrackCall(id);

  received.length = 0;
  let rr = await post(uris["600001"], { tonumber: '<img src=x onerror="alert(1)">', zohouser: "600001" });
  check("a click-to-dial 'number' with markup in it is refused", rr.status === 400, rr.status);
  await waitFor(() => received.some(x => x.path === "/phonebridge/v3/clicktodialerror"));
  const err = received.find(x => x.path === "/phonebridge/v3/clicktodialerror");
  check("and Zoho is told it was not a number (INVALID_NUMBER)", err && err.fields.code === "INVALID_NUMBER", err && err.fields);
  check("nothing was handed to the softphone", !phone.events.some(e => e.type === "dial"));
  rr = await post(uris["600001"], { tonumber: "+91 00009-00071", zohouser: "600001" });
  await waitFor(() => phone.events.some(e => e.type === "dial"));
  check("a formatted number is reduced to digits before it is dialled",
    rr.status === 200 && phone.events.some(e => e.type === "dial" && e.to === "+910000900071"), phone.events.filter(e => e.type === "dial"));
  phone.close();
  await tick(100);
}

async function testWebhookSignatures() {
  console.log("\n[19] Vobiz webhooks must be signed — the default");
  delete process.env.REQUIRE_VOBIZ_SIGNATURE;
  const hmac = (tok, s) => crypto.createHmac("sha256", tok).update(s).digest("base64");
  const v3 = (tok, p, nonce = "n19") => ({ "X-Vobiz-Signature-V3": hmac(tok, `https://example.test${p}.${nonce}`), "X-Vobiz-Signature-V3-Nonce": nonce });
  const priyaUser = vobizAccounts.sessionFor("priya").sipUser;
  const inbound = id => ({ CallUUID: id, From: "910008000020", To: "910000000001" });

  received.length = 0;
  let xml = await (await post("/answer", inbound("sig-in-1"))).text();
  check("an unsigned inbound /answer is refused — nobody rings", xml.includes("<Hangup/>") && !xml.includes("<Dial"), xml);
  check("the caller hears a polite message before the hangup, never silence", /<Speak>[^<]+<\/Speak><Hangup\/>/.test(xml), xml);
  xml = await (await post("/answer", inbound("sig-in-2"), v3(TOKENS.MA_TEST0002, "/answer"))).text();
  check("so is one signed with another account's token", xml.includes("<Hangup/>") && !xml.includes("<Dial"), xml);
  await tick(150);
  check("and neither reached Zoho", notifies().length === 0, notifies().map(n => n.fields));

  xml = await (await post("/answer", inbound("sig-in-3"), v3(TOKENS.MA_TEST0001, "/answer"))).text();
  check("signed with the owning account's token, it rings that account's agents", xml.includes(`<User>sip:${priyaUser}@`), xml);
  xml = await (await post("/answer", inbound("sig-in-4"), {
    "X-Vobiz-Signature-MA-V3": hmac(TOKENS.MA_TEST0001, "https://example.test/answer.n19"), "X-Vobiz-Signature-V3-Nonce": "n19",
  })).text();
  check("X-Vobiz-Signature-MA-V3 (a sub-account's callback, signed by the parent) verifies too", xml.includes("<Dial"), xml);
  xml = await (await post("/answer", inbound("sig-in-5"), {
    "X-Vobiz-Signature-V2": hmac(TOKENS.MA_TEST0001, "https://example.test/answern19"), "X-Vobiz-Signature-V2-Nonce": "n19",
  })).text();
  check("so does X-Vobiz-Signature-V2", xml.includes("<Dial"), xml);
  xml = await (await post("/answer", inbound("sig-in-8"), {
    "X-Vobiz-Signature-V3": hmac(TOKENS.MA_TEST0001, "https://example.test/answer.n19g"), "X-Vobiz-Signature-Nonce": "n19g",
  })).text();
  check("the nonce may come as the plain X-Vobiz-Signature-Nonce header", xml.includes("<Dial"), xml);

  // One customer signs with its own token and names another customer in the body.
  xml = await (await post("/answer?authId=MA_TEST0002", { CallUUID: "sig-in-6", From: "910008000021", To: "910000000001", ParentAuthID: "MA_TEST0001" }, v3(TOKENS.MA_TEST0002, "/answer"))).text();
  check("a webhook signed by one account never rings another account's agents", !xml.includes(priyaUser) && !xml.includes("<Dial"), xml);
  xml = await (await post("/answer?authId=MA_TEST0002", { CallUUID: "sig-out-1", From: `sip:${priyaUser}@registrar.vobiz.ai`, To: "910000900090" }, v3(TOKENS.MA_TEST0002, "/answer"))).text();
  check("nor dials out for another account's browser", !xml.includes("<Number>"), xml);

  // A callback about a call being tracked.
  received.length = 0;
  await post("/dial-event?agentId=priya&authId=MA_TEST0001", { Event: "DialAnswer", DialAction: "answer", CallUUID: "sig-in-3" });
  await tick(150);
  check("an unsigned dial-event cannot mark a call answered", !notifies().some(n => n.fields.state === "answered"), notifies().map(n => n.fields));
  await post("/dial-event?agentId=priya&authId=MA_TEST0001", { Event: "DialAnswer", DialAction: "answer", CallUUID: "sig-in-3" }, v3(TOKENS.MA_TEST0001, "/dial-event"));
  await waitFor(() => notifies().some(n => n.fields.state === "answered"));
  check("a signed one can", notifies().some(n => n.fields.state === "answered"));

  // SIP direct: this backend holds no token for it, so there is nothing to verify with.
  xml = await (await post("/answer", { CallUUID: "sig-sip-1", From: "sip:custsip01@registrar.vobiz.ai", To: "910000900091" })).text();
  check("a live SIP-direct agent's call is still dialled, unverified (no token here)", xml.includes("<Number>910000900091</Number>"), xml);
  xml = await (await post("/answer", { CallUUID: "sig-sip-2", From: "910008000022", To: "910000000009" })).text();
  check("and a call to its number still rings it", xml.includes("<User>sip:custsip01@registrar.vobiz.ai</User>"), xml);
  xml = await (await post("/answer", { CallUUID: "sig-x-1", From: "sip:stranger@registrar.vobiz.ai", To: "910000900092" })).text();
  check("an unsigned webhook that belongs to nobody here is refused", xml.includes("<Hangup/>") && !xml.includes("<Number>"), xml);
  check("with a spoken message there too", xml.includes("<Speak>This call cannot be connected right now.</Speak>"), xml);

  process.env.REQUIRE_VOBIZ_SIGNATURE = "false";
  xml = await (await post("/answer", inbound("sig-in-7"))).text();
  check("REQUIRE_VOBIZ_SIGNATURE=false accepts unsigned webhooks again (debugging only)", xml.includes("<Dial"), xml);
  for (const id of ["sig-in-1", "sig-in-2", "sig-in-3", "sig-in-4", "sig-in-5", "sig-in-6", "sig-in-7", "sig-in-8", "sig-out-1", "sig-sip-1", "sig-sip-2", "sig-x-1"]) pb.untrackCall(id);
}

async function testConnectedAccount() {
  console.log("\n[20] An admin connects the Vobiz account; agents never handle its Auth Token");
  delete process.env.ALLOW_AGENT_AUTH_TOKEN;
  const store = path.join(TMP, "vobiz-accounts.json");
  const cookie = await agentCookie("nomatch");

  let r = await postJson("/agent/vobiz-session", ACCT1, { Cookie: cookie });
  let body = await r.json();
  check("by default an agent cannot sign in with the account's Auth Token", r.status === 403 && /admin/.test(body.error), body);
  check("and the attempt changes nothing for that agent", vobizAccounts.sessionFor("nomatch").mode === "sip");
  r = await postJson("/agent/vobiz-session", {}, { Cookie: cookie });
  check("with no account connected, signing in says to ask the admin", r.status === 409, r.status);
  body = await (await req("/agent/me", { headers: { Cookie: cookie } })).json();
  check("the softphone is told: no account connected, token sign-in off",
    body.vobizSignIn && body.vobizSignIn.connectedAccount === null && body.vobizSignIn.agentTokenAllowed === false, body.vobizSignIn);

  r = await postJson("/admin/vobiz-account", ACCT2);
  check("connecting an account needs the admin", r.status === 401, r.status);
  r = await req("/admin/vobiz-account", { headers: ADMIN });
  check("the admin gets a form to connect one", r.status === 200 && (await r.text()).includes("Connect a Vobiz account"));
  r = await postJson("/admin/vobiz-account", { authId: "MA_TEST0002", authToken: "wrong-token" }, ADMIN);
  check("a wrong Auth Token is refused and nothing is stored", r.status === 401 && !fs.existsSync(store), r.status);
  r = await postJson("/admin/vobiz-account", ACCT2, ADMIN);
  body = await r.json();
  check("the admin connects MA_TEST0002 once", r.status === 200 && body.authId === "MA_TEST0002" && body.applicationId === NEW_APP_2, body);
  const disk = fs.readFileSync(store, "utf8");
  check("its Auth Token is stored sealed (AES-256-GCM), never in the clear",
    !disk.includes(TOKENS.MA_TEST0002) && JSON.parse(disk).MA_TEST0002.authToken.startsWith("v1:"), disk);

  body = await (await req("/agent/me", { headers: { Cookie: cookie } })).json();
  check("the softphone now offers that account", body.vobizSignIn.connectedAccount === "MA_TEST0002", body.vobizSignIn);
  r = await postJson("/agent/vobiz-session", {}, { Cookie: cookie });
  body = await r.json();
  check("the agent signs in without typing anything", r.status === 200 && body.authId === "MA_TEST0002" && Boolean(body.sipPassword), body);
  check("and gets their own SIP line on that account", vobizAccounts.sessionFor("nomatch").authId === "MA_TEST0002" && vobizAccounts.sessionFor("nomatch").mode === "account");

  // A restart: the token comes back from the sealed store.
  vobizAccounts.resetForTests();
  check("after a restart the connected account is known again", vobizAccounts.knownAccount("MA_TEST0002") && vobizAccounts.tokenFor("MA_TEST0002") === TOKENS.MA_TEST0002);
  r = await postJson("/agent/vobiz-session", {}, { Cookie: cookie });
  check("the agent signs in again, still without the token", r.status === 200 && (await r.json()).authId === "MA_TEST0002");
  const nomatchUser = vobizAccounts.sessionFor("nomatch").sipUser;
  delete process.env.REQUIRE_VOBIZ_SIGNATURE;
  const v3 = tok => ({ "X-Vobiz-Signature-V3": crypto.createHmac("sha256", tok).update("https://example.test/answer.n20").digest("base64"), "X-Vobiz-Signature-V3-Nonce": "n20" });
  const call = { CallUUID: "restart-1", From: "910008000030", To: "910000000003", ParentAuthID: "MA_TEST0002" };
  let xml = await (await post("/answer", call, v3(TOKENS.MA_TEST0002))).text();
  check("after a restart its webhooks verify with the sealed token, and the call rings its agent", xml.includes(`<User>sip:${nomatchUser}@registrar.vobiz.ai</User>`), xml);
  xml = await (await post("/answer", { ...call, CallUUID: "restart-2" })).text();
  check("and unsigned ones are still refused, with a spoken message", !xml.includes("<Dial") && /<Speak>[^<]+<\/Speak><Hangup\/>/.test(xml), xml);
  process.env.REQUIRE_VOBIZ_SIGNATURE = "false";
  for (const id of ["restart-1", "restart-2"]) pb.untrackCall(id);

  // Several accounts connected: each agent uses the one assigned to them.
  r = await postJson("/admin/vobiz-account", ACCT1, ADMIN);
  check("a second account can be connected", r.status === 200);
  const arjunCookie = await agentCookie("arjun");
  r = await postJson("/agent/vobiz-session", {}, { Cookie: arjunCookie });
  check("with two connected, an agent with no assignment is told to ask the admin", r.status === 409, r.status);
  const savedAgents = fs.readFileSync(AGENTS_FILE, "utf8");
  const withAssignment = JSON.parse(savedAgents);
  withAssignment.arjun.vobizAccount = "MA_TEST0001";
  await tick(20);
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(withAssignment, null, 2));
  r = await postJson("/agent/vobiz-session", {}, { Cookie: arjunCookie });
  body = await r.json();
  check("an agent assigned in agents.json (vobizAccount) signs in on that account", r.status === 200 && body.authId === "MA_TEST0001", body);
  r = await postJson("/agent/vobiz-session", { authId: "MA_TEST0002" }, { Cookie: arjunCookie });
  body = await r.json();
  check("and cannot ask for a different connected account", r.status === 200 && body.authId === "MA_TEST0001", body);
  await tick(20);
  fs.writeFileSync(AGENTS_FILE, savedAgents);

  r = await postJson("/admin/vobiz-account/disconnect", { authId: "MA_TEST0002" }, ADMIN);
  check("disconnecting an account succeeds", r.status === 200, r.status);
  check("its token is deleted from disk and memory",
    !fs.readFileSync(store, "utf8").includes("MA_TEST0002") && !vobizAccounts.knownAccount("MA_TEST0002"));
  check("and its agents are signed out", vobizAccounts.sessionFor("nomatch") === null);
  r = await postJson("/admin/vobiz-account/disconnect", { authId: "MA_TEST0002" }, ADMIN);
  check("disconnecting it again is a 404", r.status === 404, r.status);

  process.env.ALLOW_AGENT_AUTH_TOKEN = "true";
  r = await postJson("/agent/vobiz-session", ACCT2, { Cookie: cookie });
  check("ALLOW_AGENT_AUTH_TOKEN=true restores the old token sign-in, for a migration", r.status === 200, r.status);
  check("no Auth Token appears in any HTTP response, admin replies included",
    !seenResponses.some(t => t.includes(TOKENS.MA_TEST0001) || t.includes(TOKENS.MA_TEST0002)));
}

async function testBaseline(uris) {
  console.log("\n[21] Every outcome reaches Zoho; one line per agent; ICE is capped; callbacks trust only what is signed");

  // A click-to-dial that never becomes a connected call is still closed in Zoho.
  const phone = await openSoftphone("priya", ACCT1);
  await tick();
  const click = async to => (await (await post(uris["600001"], { tonumber: to, zohouser: "600001" })).json()).callid;
  const closedAs = id => notifies().find(n => n.fields.id === id && n.fields.state !== "ringing");

  received.length = 0;
  const failed = await click("+910000900081");
  await waitFor(() => phone.events.some(e => e.type === "dial" && e.callId === failed));
  check("the softphone gets the click's call id with the number", phone.events.some(e => e.type === "dial" && e.callId === failed && e.to === "+910000900081"));
  let r = await postJson("/agent/call-failed", { callId: failed, cause: "Busy" }, { Cookie: await agentCookie("arjun") });
  check("another agent cannot close someone else's click", r.status === 404, r.status);
  r = await postJson("/agent/call-failed", { callId: failed, cause: "Busy" });
  check("nor can a request without an agent session", r.status === 401, r.status);
  r = await postJson("/agent/call-failed", { callId: failed, cause: "Busy" }, { Cookie: phone.cookie });
  await waitFor(() => closedAs(failed));
  let closed = closedAs(failed);
  check("a click the softphone failed to place is logged in Zoho, not left ringing (failed sessions are logged)",
    r.status === 200 && closed && closed.fields.state === "ended" && closed.fields.duration === "0" && closed.fields.type === "dialed" && closed.fields.zohouser === "600001", closed && closed.fields);
  check("with a start_time, as Zoho requires on ended", closed && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(closed.fields.start_time), closed && closed.fields);
  r = await postJson("/agent/call-failed", { callId: failed, cause: "Busy" }, { Cookie: phone.cookie });
  await tick();
  check("and closed once only", r.status === 404 && notifies().filter(n => n.fields.id === failed && n.fields.state === "ended").length === 1);
  received.length = 0;
  const instant = await click(SLOW_RINGING_TO);
  await postJson("/agent/call-failed", { callId: instant, cause: "not registered" }, { Cookie: phone.cookie });
  await waitFor(() => closedAs(instant));
  const order = notifies().filter(n => n.fields.id === instant).map(n => n.fields.state);
  check("a click that fails at once reaches Zoho as ringing then ended, never ended first", JSON.stringify(order) === '["ringing","ended"]', order);

  received.length = 0;
  const first = await click("+910000900082");
  const second = await click("+910000900083");
  await waitFor(() => closedAs(first));
  check("a click replaced by a newer one before it became a call is closed in Zoho", Boolean(closedAs(first)) && closedAs(first).fields.state === "ended", closedAs(first) && closedAs(first).fields);
  check("the newer one keeps waiting for its call", !closedAs(second));
  const xml = await (await post("/answer", { CallUUID: "base-bound-1", From: sipFrom(phone), To: "910000900083" })).text();
  const tracked = pb.getTrackedCall("base-bound-1");
  check("and binds to the call the softphone then places", /<Number>910000900083<\/Number>/.test(xml) && tracked && tracked.callId === second, tracked);
  r = await postJson("/agent/call-failed", { callId: second, cause: "Busy" }, { Cookie: phone.cookie });
  check("a failure report for a call Vobiz already has changes nothing — its webhooks log it", r.status === 404 && Boolean(pb.getTrackedCall("base-bound-1")), r.status);
  received.length = 0;
  await finalizeZohoPhoneBridgeCall("base-bound-1");
  check("a customer who never answered (busy, no answer, declined) is logged with 0 s", closedAs(second) && closedAs(second).fields.state === "ended" && closedAs(second).fields.duration === "0", closedAs(second) && closedAs(second).fields);

  process.env.CLICK_TO_DIAL_TIMEOUT_MS = "150";
  received.length = 0;
  const lost = await click("+910000900084");
  await waitFor(() => closedAs(lost), 3000);
  check("a click that nothing happens to is closed once CLICK_TO_DIAL_TIMEOUT_MS runs out", Boolean(closedAs(lost)) && closedAs(lost).fields.state === "ended", closedAs(lost) && closedAs(lost).fields);
  delete process.env.CLICK_TO_DIAL_TIMEOUT_MS;

  received.length = 0;
  const left = await click("+910000900085");
  await postJson("/agent/vobiz-logout", {}, { Cookie: phone.cookie });
  await waitFor(() => closedAs(left));
  check("signing out of Vobiz closes the click that was waiting", Boolean(closedAs(left)));
  phone.close();

  // One phone line per agent, in SIP-direct mode too.
  const lineOne = await openSoftphone("nomatch", ACCT2);
  const lineTwo = await openSoftphone("nomatch", { sipUser: "custsip01", callerId: "+910000000009" });
  await waitFor(() => lineOne.events.some(e => e.type === "signed-in-elsewhere"));
  check("a SIP-direct sign-in in another tab also tells the first tab", lineOne.events.some(e => e.type === "signed-in-elsewhere") && !lineTwo.events.some(e => e.type === "signed-in-elsewhere"));
  lineOne.close();
  lineTwo.close();

  // A callback's query string is not covered by the signature, so it names nobody.
  const priyaTab = await openSoftphone("priya", ACCT1);
  const arjunTab = await openSoftphone("arjun", ACCT1);
  await tick();
  await post("/dial-result?agentId=arjun&authId=MA_TEST0001", { CallUUID: "base-q-1", DialStatus: "completed", From: sipFrom(priyaTab) });
  await waitFor(() => priyaTab.events.some(e => e.type === "call-ended"));
  await tick();
  check("dial-result tells the agent whose call it was, whatever ?agentId= says",
    priyaTab.events.some(e => e.type === "call-ended") && !arjunTab.events.some(e => e.type === "call-ended"), { arjun: arjunTab.events });
  priyaTab.close();
  arjunTab.close();

  // Recording audio is fetched with credentials only from Vobiz, only over HTTPS.
  recordingUrlForStub = "http://media.vobiz.ai/recordings/rec-1.mp3";
  vobizCalls = [];
  r = await req(recordingLink);
  check("a recording URL that is not HTTPS is never fetched with credentials", r.status === 404 && !vobizCalls.some(c => c.target.startsWith("http://")), vobizCalls.map(c => c.target));
  recordingUrlForStub = "https://media.vobiz.ai/recordings/rec-1.mp3";
  r = await req(recordingLink);
  check("the same recording over HTTPS plays", r.status === 200, r.status);

  // ICE gathering is capped: the page's own capIceGathering, run on a fake session.
  const html = await (await req("/agent-phone")).text();
  const source = (html.match(/function capIceGathering\([\s\S]*?\n}\n/) || [""])[0];
  const runCap = (candidates, capMs) => new Promise(resolve => {
    const handlers = {};
    const fakeSession = { on: (name, fn) => { handlers[name] = fn; } };
    const ctx = vm.createContext({ ICE_CAP_MS: capMs, setTimeout, Date, console: { info() {} } });
    vm.runInContext(source, ctx);
    ctx.capIceGathering(fakeSession, "test");
    const t0 = Date.now();
    const readyAt = [];
    for (const candidate of candidates) handlers.icecandidate({ candidate, ready: () => readyAt.push(Date.now() - t0) });
    setTimeout(() => resolve(readyAt), capMs + 200);
  });
  const host = { type: "host", candidate: "candidate:1 1 udp 2122260223 192.0.2.10 54321 typ host generation 0" };
  const srflx = { type: "srflx", candidate: "candidate:2 1 udp 1686052607 203.0.113.7 54321 typ srflx raddr 192.0.2.10 rport 54321" };
  let readyAt = await runCap([host, srflx], 400);
  check("ICE: the SDP goes at the first reflexive candidate, once", readyAt.length === 1 && readyAt[0] < 100, readyAt);
  readyAt = await runCap([host, host], 150);
  check("ICE: with no reflexive candidate it goes ICE_CAP_MS after the first one, once", readyAt.length === 1 && readyAt[0] >= 130, readyAt);
  check("ICE: the page caps gathering at 2.5 s", html.includes("const ICE_CAP_MS = 2500;"));
  check("ICE: on the outbound call and on the inbound answer",
    html.includes('capIceGathering(session, "call");') && /capIceGathering\(session, "answer"\);\s*session\.answer\(/.test(html));
  check("WebRTC: session timers off, STUN on every call() and answer(), a user agent with no space",
    html.includes("session_timers: false") && (html.match(/iceServers: \[\{ urls: \["stun:/g) || []).length === 2 && /user_agent: "[^" ]+"/.test(html));
}

// --- Runner ----------------------------------------------------------------

(async () => {
  console.log("Zoho PhoneBridge backend — hermetic end-to-end tests\n" + "=".repeat(58));
  const mock = await startMockZoho();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  B = `http://127.0.0.1:${server.address().port}`;
  try {
    await testServerInfoAndTime();
    await testTokenStore();
    await testRouteAuth();
    const orgId = await testOAuth();
    const uris = await testRegistration(orgId);
    await testClickToDial(orgId, uris);
    await testInbound(orgId);
    await testCallbackContract();
    await testAnyAccount(orgId);
    await testOutboundRecordSetting();
    await testTabsAndManualDials(orgId, uris);
    await testInboundAnswerer();
    await testMicrophonePrompt();
    await testMalformedRequests();
    await testSoftphoneHardening(uris);
    await testWebhookSignatures();
    await testConnectedAccount();
    await testBaseline(uris);
    await testDisconnect(orgId);
    await testNoAgentsFile();
  } catch (err) {
    fail += 1;
    console.error("\nUnexpected error:", err);
  } finally {
    server.closeAllConnections && server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => mock.close(resolve));
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log("\n" + "=".repeat(58));
  console.log(`${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
