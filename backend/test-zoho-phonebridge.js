"use strict";

/**
 * End-to-end tests for the Zoho PhoneBridge backend.
 *
 *   node test-zoho-phonebridge.js
 *
 * Hermetic: a mock Zoho (OAuth + PhoneBridge V3) runs on localhost, Vobiz's
 * REST API and Zoho's serverinfo directory are stubbed, and every file the
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

// --- Isolated environment, set before anything is required ---------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "vobiz-zoho-test-"));
const MOCK_PORT = 8094;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
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
  VOBIZ_AUTH_ID: "MA_TESTACCOUNT",
  VOBIZ_AUTH_TOKEN: "test-auth-token",
  VOBIZ_FROM_NUMBER: "+911111111111",
  ZOHO_PB_CLIENT_ID: "1000.TESTCLIENT",
  ZOHO_PB_CLIENT_SECRET: "test-client-secret",
  ZOHO_PB_REDIRECT_URI: "https://example.test/oauth/zoho/callback",
  ZOHO_PB_RECORDING_GRACE_MS: "60000",
});
for (const k of ["REQUIRE_VOBIZ_SIGNATURE", "CLICKTODIAL_WHEN_OFFLINE", "ZOHO_PB_SEND_MISSED_STATE", "RECORDING_URL_SECRET"]) delete process.env[k];

fs.writeFileSync(AGENTS_FILE, JSON.stringify({
  priya: { displayName: "Priya", sipUser: "priya123@registrar.vobiz.ai", sipPassword: "priya-sip-secret", zohoUser: "600001", callerId: "+912222222222" },
  arjun: { displayName: "Arjun", sipUser: "arjun456@registrar.vobiz.ai", sipPassword: "arjun-sip-secret", email: "Arjun@Example.com" },
  nomatch: { displayName: "Unmapped", sipUser: "zzz@registrar.vobiz.ai", sipPassword: "x" },
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
        received.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: req.method, auth: req.headers.authorization, contentType: req.headers["content-type"], fields });
        const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };

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
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}

// --- Stubbed outside world --------------------------------------------------

const realFetch = globalThis.fetch;
let vobizCalls = [];
let recordingUrlForStub = "https://media.vobiz.ai/recordings/rec-1.mp3";
globalThis.fetch = async (input, init = {}) => {
  const target = typeof input === "string" ? input : input.url;
  if (target === "https://accounts.zoho.com/oauth/serverinfo") {
    return new Response(JSON.stringify({ locations: { us: "https://accounts.zoho.com", in: "https://accounts.zoho.in", test: MOCK } }), { status: 200 });
  }
  if (target.startsWith("https://media.vobiz.ai/")) {
    return new Response("ID3-fake-mp3", { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  }
  if (target.includes("api.vobiz.ai")) {
    const method = (init.method || "GET").toUpperCase();
    vobizCalls.push({ target, method, headers: init.headers, body: String(init.body || "") });
    if (method === "GET" && /\/Recording\/[^/]+\/$/.test(target)) {
      return new Response(JSON.stringify({ recording_url: recordingUrlForStub, recording_format: "mp3" }), { status: 200 });
    }
    if (method === "GET" && /\/Call\/([^/]+)\/$/.test(target)) {
      const id = target.match(/\/Call\/([^/]+)\/$/)[1];
      return new Response(JSON.stringify({ bill_duration: id.startsWith("bleg") ? 37 : 99 }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "Call fired", request_uuid: "mock-request-uuid" }), { status: 200 });
  }
  return realFetch(input, init);
};

const pb = require("./zoho-phonebridge");
const { createTokenStore } = require("./token-store");
const { server, auth, finalizeZohoPhoneBridgeCall, verifyVobizSignature } = require("./server");
let B = "";

const req = (p, opts = {}) => realFetch(`${B}${p}`, { redirect: "manual", ...opts });
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
  check("the signed-in agent reads its own SIP credentials", r.status === 200 && body.sipPassword === "priya-sip-secret" && body.agentId === "priya", body);
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
  r = await post("/zoho/phonebridge/clicktodial?orgId=whatever&agentId=priya", { tonumber: "+919999900001" });
  check("click-to-dial without its token is 401", r.status === 401);
  r = await post(`/zoho/phonebridge/clicktodial?orgId=whatever&agentId=arjun&t=${auth.clickToDialToken("whatever", "priya")}`, { tonumber: "+919999900001" });
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

function openSoftphone(agentId) {
  return new Promise(async resolve => {
    const s = await postJson("/agent-session", { agentId, key: auth.agentKey(agentId) });
    const cookie = (s.headers.get("set-cookie") || "").split(";")[0];
    const events = [];
    const r = http.get(`${B}/call-events`, { headers: { Cookie: cookie } }, res => {
      res.on("data", chunk => {
        for (const line of String(chunk).split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
      });
      resolve({ events, close: () => r.destroy() });
    });
  });
}

async function testClickToDial(orgId, uris) {
  console.log("\n[6] Click-to-dial → browser A leg → customer → call log");

  received.length = 0;
  vobizCalls = [];
  let r = await post(uris["600001"], { tonumber: "+919999900001" });
  let body = await r.json();
  check("with no softphone open the dial is refused, not attempted over REST", r.status === 409 && vobizCalls.length === 0, { status: r.status, vobizCalls });
  await waitFor(() => received.some(x => x.path === "/phonebridge/v3/clicktodialerror"));
  const err = received.find(x => x.path === "/phonebridge/v3/clicktodialerror");
  check("and Zoho is told why (clicktodialerror AGENT_OFFLINE)", err && err.fields.code === "AGENT_OFFLINE", err && err.fields);

  const phone = await openSoftphone("priya");
  await tick();
  received.length = 0;
  r = await post(uris["600001"], { tonumber: "+919999900001", zohouser: "600001" });
  body = await r.json();
  check("the click is accepted with a call id", r.status === 200 && /^vobiz-browser-/.test(body.callid), body);
  await waitFor(() => phone.events.some(e => e.type === "dial"));
  check("the number is handed to the softphone", phone.events.some(e => e.type === "dial" && e.to === "+919999900001"));
  check("no REST call was placed", vobizCalls.length === 0, vobizCalls);
  await waitFor(() => notifies().length >= 1);
  const ringing = notifies()[0];
  check("Zoho hears ringing for that user, without start_time", ringing && ringing.fields.state === "ringing" && ringing.fields.zohouser === "600001" && !("start_time" in ringing.fields), ringing && ringing.fields);
  check("the caller ID is the agent's own", ringing && ringing.fields.from === "+912222222222");

  // The browser's INVITE reaches Vobiz, which fetches the endpoint's answer URL.
  // No ?agentId= — the agent is recognised from the SIP username.
  const callUuid = "aleg-uuid-1";
  r = await post("/answer", { CallUUID: callUuid, From: "sip:priya123@registrar.vobiz.ai", To: "919999900001", Direction: "inbound" });
  const xml = await r.text();
  check("/answer dials the customer with <Dial><Number>", /<Dial[^>]*>\s*<Number>919999900001<\/Number>/.test(xml), xml);
  check("with the agent's caller ID", xml.includes('callerId="+912222222222"'));
  check("never with <Dial><User>", !xml.includes("<User>"));
  check("and a callbackUrl to see the customer answer", xml.includes("/dial-event?agentId=priya"));

  received.length = 0;
  await post("/dial-event?agentId=priya", { Event: "DialAnswer", DialAction: "answer", CallUUID: callUuid, DialBLegUUID: "bleg-uuid-1" });
  await post("/dial-event?agentId=priya", { Event: "DialAnswer", DialAction: "answer", CallUUID: callUuid, DialBLegUUID: "bleg-uuid-1" });
  await waitFor(() => notifies().length >= 1);
  await tick();
  check("answered is reported exactly once", notifies().filter(n => n.fields.state === "answered").length === 1, notifies().map(n => n.fields.state));

  r = await post("/dial-result?agentId=priya", { CallUUID: callUuid, DialStatus: "completed", DialBLegUUID: "bleg-uuid-1" });
  check("dial-result answers an empty <Response>", /<Response><\/Response>/.test(await r.text()));

  received.length = 0;
  await post("/recording-ready?agentId=priya", { Event: "RecordStop", CallUUID: callUuid, RecordingID: "rec-1", RecordingDuration: "30" });
  await waitFor(() => notifies().length >= 1);
  const ended = notifies()[0];
  check("the call log lands with the recording (browser-originated calls used to lose it)", ended && ended.fields.state === "ended" && Boolean(ended.fields.voiceuri), ended && ended.fields);
  check("duration is the customer leg's billed time", ended && ended.fields.duration === "37", ended && ended.fields);
  check("ended carries a GMT start_time", ended && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ended.fields.start_time));
  check("the recording link carries no Vobiz credential", ended && !ended.fields.voiceuri.includes("test-auth-token") && !ended.fields.voiceuri.includes("MA_TEST"));

  const link = ended.fields.voiceuri.replace("https://example.test", "");
  r = await req(link);
  check("the signed recording link streams audio", r.status === 200 && (r.headers.get("content-type") || "").includes("audio"), r.status);
  r = await req(link.replace(/sig=[0-9a-f]+/, "sig=" + "0".repeat(64)));
  check("a bad signature is 403", r.status === 403);
  recordingUrlForStub = "https://example.com/";
  r = await req(link);
  check("a recording URL off vobiz.ai is never fetched with credentials", r.status === 404 && !vobizCalls.some(c => c.target.startsWith("https://example.com")));
  recordingUrlForStub = "https://media.vobiz.ai/recordings/rec-1.mp3";

  // Zoho says another mapped user clicked a URI registered for priya: route to that user's agent.
  const arjunPhone = await openSoftphone("arjun");
  await tick();
  r = await post(uris["600001"], { tonumber: "+919999900002", zohouser: "600002" });
  await waitFor(() => arjunPhone.events.some(e => e.type === "dial"));
  check("the clicking Zoho user's mapped agent gets the call", arjunPhone.events.some(e => e.type === "dial" && e.to === "+919999900002"));
  phone.close();
  arjunPhone.close();
}

async function testInbound(orgId) {
  console.log("\n[7] Inbound — callerId is the dialled DID, and the call is logged in Zoho");
  received.length = 0;
  const r = await post("/inbound-answer?agentId=priya", { CallUUID: "in-uuid-1", From: "919800000000", To: "918000000000" });
  const xml = await r.text();
  check("the <Dial> carries callerId = the DID", xml.includes('callerId="+918000000000"'), xml);
  check("rings for 20 seconds, as documented", xml.includes('timeout="20"'));
  check("then voicemail", xml.includes("leave a message"));
  await waitFor(() => notifies().length >= 1);
  const ring = notifies()[0];
  check("Zoho hears a received/ringing call for the mapped user", ring && ring.fields.type === "received" && ring.fields.zohouser === "600001" && ring.fields.from === "+919800000000", ring && ring.fields);

  received.length = 0;
  await finalizeZohoPhoneBridgeCall("in-uuid-1");
  const ended = notifies()[0];
  check("an unanswered inbound call is logged as ended/0s, accepted by Zoho", ended && ended.fields.state === "ended" && ended.fields.duration === "0", ended && ended.fields);

  const hang = await post("/inbound-answer?agentId=priya", { Event: "Hangup", CallUUID: "in-uuid-1" });
  check("a Hangup event is acknowledged, not answered with <Dial>", !(await hang.text()).includes("<Dial"));
}

async function testCallbackContract() {
  console.log("\n[8] Callback contract and the missed state");
  let r = await post("/answer", { CallUUID: "x", From: "+911", To: "+912" });
  check("/answer for no known agent speaks and hangs up instead of crashing", (await r.text()).includes("cannot be connected"));
  r = await post("/answer?agentId=priya", { CallUUID: "x", Event: "Hangup" });
  check("/answer acknowledges Hangup with an empty document", /<Response><\/Response>/.test(await r.text()));

  received.length = 0;
  const credentials = { clientId: "x", clientSecret: "y" };
  const orgId = pb.listOrgs()[0].orgId;
  const bare = await pb.notifyCall({ orgId, type: "received", state: "missed", callId: "m1", from: "+1", to: "+2", credentials });
  check("missed now carries its mandatory start_time and is accepted", bare.ok && /\d{4}-\d{2}-\d{2} /.test(received[0].fields.start_time), received[0] && received[0].fields);
  check("missed carries no duration", !("duration" in received[0].fields));

  const nonce = "abc123";
  const sig = crypto.createHmac("sha256", "test-auth-token").update(`https://example.test/answer.${nonce}`).digest("base64");
  const fake = h => ({ headers: h });
  const u = new URL("https://x/answer?agentId=priya");
  check("a correct X-Vobiz-Signature-V3 verifies (query string excluded)", verifyVobizSignature(fake({ "x-vobiz-signature-v3": sig, "x-vobiz-signature-v3-nonce": nonce }), u));
  check("a wrong one does not", !verifyVobizSignature(fake({ "x-vobiz-signature-v3": sig, "x-vobiz-signature-v3-nonce": "other" }), u));
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
