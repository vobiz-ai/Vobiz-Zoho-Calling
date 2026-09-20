"use strict";

/**
 * End-to-end test for the Zoho PhoneBridge integration.
 *
 * Runs a MOCK Zoho: a local server that impersonates Zoho's PhoneBridge V3
 * API (clicktodial + callnotify), so the whole call lifecycle can be proven
 * without a Zoho org, without consent screens, and without placing a real
 * billed phone call. Every request the integration would send to Zoho is
 * captured and printed verbatim.
 *
 *   node test-zoho-phonebridge.js
 *
 * What it does NOT cover, because it cannot without a real org:
 *   - whether Zoho accepts our OAuth scopes
 *   - whether Zoho's UI renders the states the way we expect
 * Those need the live walkthrough in ZOHO-PHONEBRIDGE-TESTING.md.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const pb = require("./zoho-phonebridge");

const MOCK_PORT = 8094;
const ORGS_FILE = path.join(__dirname, "zoho-orgs.json");
const TEST_ORG_ID = "__test__mock-org";

const received = [];
let pass = 0;
let fail = 0;

// The only three callnotify states Zoho's live API accepts — verified against
// the real org on 15 Sep 2026 (ISSUES.md #4).
const ACCEPTED_STATES = new Set(["ringing", "answered", "ended"]);

function check(label, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}`);
    if (detail !== undefined) console.log(`      got: ${JSON.stringify(detail)}`);
  }
}

// --- Mock Zoho -------------------------------------------------------------

function startMockZoho() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", c => (raw += c));
      req.on("end", () => {
        const fields = Object.fromEntries(new URLSearchParams(raw));
        received.push({
          path: req.url,
          method: req.method,
          auth: req.headers.authorization,
          contentType: req.headers["content-type"],
          fields,
        });
        // Mirror the live API rather than saying yes to everything: Zoho
        // accepts only three callnotify states and answers 400 to the rest,
        // documented or not (ISSUES.md #4). A mock that accepts `missed` hides
        // exactly the bug that loses a call log in production.
        if (req.url.startsWith("/phonebridge/v3/callnotify") && !ACCEPTED_STATES.has(fields.state)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error", code: "INVALID_DATA", message: `unsupported state '${fields.state}'` }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", code: "SUCCESS" }));
      });
    });
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}

// --- Test org --------------------------------------------------------------

function seedTestOrg() {
  pb.saveOrg(TEST_ORG_ID, {
    location: "test",
    accountsDomain: `http://127.0.0.1:${MOCK_PORT}`,
    apiDomain: `http://127.0.0.1:${MOCK_PORT}`,
    accessToken: "mock-access-token",
    refreshToken: "mock-refresh-token",
    // Far future, so no refresh is attempted against the mock.
    expiresAt: Date.now() + 60 * 60 * 1000,
    scope: pb.PHONEBRIDGE_SCOPES,
    connectedAt: new Date().toISOString(),
  });
}

function removeTestOrg() {
  try {
    const orgs = JSON.parse(fs.readFileSync(ORGS_FILE, "utf8"));
    delete orgs[TEST_ORG_ID];
    if (Object.keys(orgs).length === 0) fs.unlinkSync(ORGS_FILE);
    else fs.writeFileSync(ORGS_FILE, JSON.stringify(orgs, null, 2));
  } catch {
    /* nothing to clean up */
  }
}

// --- Tests -----------------------------------------------------------------

async function testServerInfo() {
  console.log("\n[1] Datacentre resolution (live call to Zoho)");
  const locations = await pb.resolveServerInfo();
  const codes = Object.keys(locations);
  check("serverinfo returns locations", codes.length > 0);
  check("includes the datacentres Zoho's partner email named", ["us", "eu", "in", "au", "ca", "jp"].every(c => codes.includes(c)), codes);
  check("every value is an https accounts domain", Object.values(locations).every(v => v.startsWith("https://accounts.")), locations);

  const inDomain = await pb.accountsDomainForLocation("in");
  check("location 'in' resolves to the India accounts domain", inDomain === "https://accounts.zoho.in", inDomain);

  let threw = false;
  try {
    await pb.accountsDomainForLocation("atlantis");
  } catch {
    threw = true;
  }
  check("an unknown location is rejected rather than guessed at", threw);
  console.log(`      -> ${codes.length} datacentres: ${codes.join(", ")}`);
}

async function testTimeFormat() {
  console.log("\n[2] Timestamp format");
  const formatted = pb.toZohoGmt(Date.UTC(2026, 8, 15, 9, 5, 3));
  check('is "yyyy-MM-dd HH:mm:ss" with no timezone suffix', formatted === "2026-09-15 09:05:03", formatted);
  check("has no ISO 'T' separator", !formatted.includes("T"), formatted);
  check("has no milliseconds or Z", !/\.|Z/.test(formatted), formatted);
}

async function testOutboundLifecycle() {
  console.log("\n[3] Outbound call lifecycle (dialed: ringing -> answered -> ended)");
  received.length = 0;

  const callUuid = "mock-uuid-outbound";
  const callId = `vobiz-${callUuid}`;
  const from = "+91XXXXXXXXXX";
  const to = "+919999900001";
  const credentials = { clientId: "x", clientSecret: "y" };

  pb.trackCall(callUuid, { orgId: TEST_ORG_ID, callId, agentId: "test-agent", type: "dialed", from, to });

  await pb.notifyCall({ orgId: TEST_ORG_ID, type: "dialed", state: "ringing", callId, from, to, credentials });

  const answeredAt = Date.now();
  pb.updateTrackedCall(callUuid, { answeredAtMs: answeredAt });
  await pb.notifyCall({ orgId: TEST_ORG_ID, type: "dialed", state: "answered", callId, from, to, credentials });

  await pb.notifyCall({
    orgId: TEST_ORG_ID, type: "dialed", state: "ended", callId, from, to,
    startedAtMs: answeredAt, durationSec: 42,
    voiceUri: "https://example.test/zoho/phonebridge/recording?sig=abc",
    credentials,
  });

  check("three notifications were sent", received.length === 3, received.length);
  check("all hit /phonebridge/v3/callnotify", received.every(r => r.path === "/phonebridge/v3/callnotify"), received.map(r => r.path));
  check("all use POST", received.every(r => r.method === "POST"), received.map(r => r.method));
  check("auth header is Zoho-oauthtoken, not Bearer", received.every(r => r.auth === "Zoho-oauthtoken mock-access-token"), received[0] && received[0].auth);
  check("content-type is form-encoded", received.every(r => (r.contentType || "").includes("x-www-form-urlencoded")), received[0] && received[0].contentType);
  check("states arrive in order", received.map(r => r.fields.state).join(",") === "ringing,answered,ended", received.map(r => r.fields.state));
  check("call id is identical across all three", new Set(received.map(r => r.fields.id)).size === 1, received.map(r => r.fields.id));
  check("type is 'dialed' throughout", received.every(r => r.fields.type === "dialed"), received.map(r => r.fields.type));
  check("from/to survive unchanged", received.every(r => r.fields.from === from && r.fields.to === to));

  const ended = received[2].fields;
  check("ended carries duration", ended.duration === "42", ended.duration);
  check("ended carries a GMT start_time", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ended.start_time), ended.start_time);
  check("ended carries voiceuri", Boolean(ended.voiceuri), ended.voiceuri);
  check("ringing does NOT carry duration", received[0].fields.duration === undefined, received[0].fields);

  pb.untrackCall(callUuid);
  console.log("\n      Exactly what was POSTed to Zoho:");
  received.forEach(r => console.log(`        ${JSON.stringify(r.fields)}`));
}

async function testInboundAndMissed() {
  console.log("\n[4] Inbound call, never answered (received: ringing -> ended/0s)");
  received.length = 0;

  const callId = "vobiz-mock-uuid-inbound";
  const credentials = { clientId: "x", clientSecret: "y" };
  const from = "+919999900001";
  const to = "+91XXXXXXXXXX";

  await pb.notifyCall({ orgId: TEST_ORG_ID, type: "received", state: "ringing", callId, from, to, credentials });

  // What Zoho documents, and what it actually does, are different things: the
  // live API answers 400 to `missed`, so sending it loses the call log
  // entirely. Prove the mock behaves the same way before relying on it.
  const rejected = await pb.notifyCall({
    orgId: TEST_ORG_ID, type: "received", state: "missed", callId, from, to,
    startedAtMs: Date.now(), durationSec: 0, credentials,
  });
  check("Zoho rejects the documented 'missed' state (ISSUES.md #4)", rejected.ok === false && rejected.status === 400, rejected);

  const accepted = await pb.notifyCall({
    orgId: TEST_ORG_ID, type: "received", state: "ended", callId, from, to,
    startedAtMs: Date.now(), durationSec: 0, credentials,
  });
  check("the same call logs fine as 'ended' with duration 0", accepted.ok === true, accepted);
  check("type is 'received' for inbound", received.every(r => r.fields.type === "received"), received.map(r => r.fields.type));
  check("caller is the customer, callee is our number", received[0].fields.from === from && received[0].fields.to === to);
  check("the zero-duration log still carries a start_time", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(received[2].fields.start_time), received[2].fields);
}

async function testClickToDialRegistration() {
  console.log("\n[5] Click-to-dial registration");
  received.length = 0;

  const uri = "https://example.test/zoho/phonebridge/clicktodial?orgId=x&agentId=test-agent";
  const result = await pb.registerClickToDial({
    orgId: TEST_ORG_ID,
    clickToDialUri: uri,
    credentials: { clientId: "x", clientSecret: "y" },
  });

  check("registration succeeded", result.ok === true, result);
  check("hit /phonebridge/v3/clicktodial", received[0] && received[0].path === "/phonebridge/v3/clicktodial", received[0] && received[0].path);
  check("sent clicktodialuri", received[0] && received[0].fields.clicktodialuri === uri, received[0] && received[0].fields);
  check("stored against the org", pb.getOrg(TEST_ORG_ID).clickToDialUri === uri);
}

async function testMultiTenancy() {
  console.log("\n[6] Multi-tenancy — two orgs in different datacentres");
  pb.saveOrg("__test__org-eu", {
    location: "eu", accountsDomain: "https://accounts.zoho.eu",
    apiDomain: "https://www.zohoapis.eu", accessToken: "eu-token",
    refreshToken: "eu-refresh", expiresAt: Date.now() + 3600_000,
  });
  pb.saveOrg("__test__org-in", {
    location: "in", accountsDomain: "https://accounts.zoho.in",
    apiDomain: "https://www.zohoapis.in", accessToken: "in-token",
    refreshToken: "in-refresh", expiresAt: Date.now() + 3600_000,
  });

  const eu = pb.getOrg("__test__org-eu");
  const ind = pb.getOrg("__test__org-in");
  check("both orgs stored independently", Boolean(eu && ind));
  check("EU org keeps EU domains", eu.apiDomain === "https://www.zohoapis.eu" && eu.accountsDomain === "https://accounts.zoho.eu", eu);
  check("India org keeps India domains", ind.apiDomain === "https://www.zohoapis.in" && ind.accountsDomain === "https://accounts.zoho.in", ind);
  check("tokens do not bleed between orgs", eu.accessToken !== ind.accessToken);

  const listed = pb.listOrgs();
  check("listOrgs never exposes tokens", listed.every(o => !("accessToken" in o) && !("refreshToken" in o)), listed[0]);

  const orgs = JSON.parse(fs.readFileSync(ORGS_FILE, "utf8"));
  delete orgs["__test__org-eu"];
  delete orgs["__test__org-in"];
  fs.writeFileSync(ORGS_FILE, JSON.stringify(orgs, null, 2));
}

// --- The HTTP routes themselves --------------------------------------------
//
// Everything above tests the PhoneBridge module. These drive the real server
// routes, because the two bugs that hurt most in practice lived in the glue
// between them and were invisible from either side alone.

const AGENTS_FILE = path.join(__dirname, "agents.json");
const AGENTS_EXAMPLE = path.join(__dirname, "agents.example.json");
let createdAgentsFile = false;
let realFetch = null;
let vobizCalls = [];
let backend = null;
let backendPort = 0;

function ensureAgentsFile() {
  if (fs.existsSync(AGENTS_FILE)) return;      // never touch a real one
  fs.copyFileSync(AGENTS_EXAMPLE, AGENTS_FILE);
  createdAgentsFile = true;
}

/**
 * Stands in for VoBiz's Call API. Everything else — the mock Zoho, the live
 * serverinfo lookup — goes through to the real fetch untouched.
 */
function stubVobizApi() {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const target = typeof input === "string" ? input : input.url;
    if (!target.includes("api.vobiz.ai")) return realFetch(input, init);
    // CDR lookup — finalize reads the billed duration from here.
    if ((!init || (init.method || "GET") === "GET") && /\/Call\/[^/]+\/$/.test(target)) {
      return new Response(JSON.stringify({ bill_duration: 37, hangup_cause_code: 4000 }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    const body = String((init && init.body) || "");
    const params = new URLSearchParams(body);
    vobizCalls.push(Object.fromEntries(params));
    // A destination VoBiz refuses, so the rejection path can be exercised.
    if (params.get("to") === "+910000000000") {
      return new Response(JSON.stringify({ error: "invalid destination" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: "Call fired", request_uuid: "mock-request-uuid" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
}

async function startBackend() {
  // server.js reads these at require time, so they have to be set first.
  process.env.PUBLIC_BASE_URL = "https://example.test";
  process.env.VOBIZ_AUTH_ID = "MA_TESTACCOUNT";
  process.env.VOBIZ_AUTH_TOKEN = "test-auth-token";
  process.env.VOBIZ_FROM_NUMBER = "+91XXXXXXXXXX";
  ensureAgentsFile();
  stubVobizApi();
  const mod = require("./server");
  await new Promise(resolve => mod.server.listen(0, "127.0.0.1", resolve));
  backendPort = mod.server.address().port;
  backend = mod;
}

function clickToDial({ orgId = TEST_ORG_ID, agentId = "test-agent", to = "+919999900001" } = {}) {
  const qs = `orgId=${encodeURIComponent(orgId)}&agentId=${encodeURIComponent(agentId)}`;
  return realFetch(`http://127.0.0.1:${backendPort}/zoho/phonebridge/clicktodial?${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ tonumber: to }).toString(),
  });
}

/** The fire-and-forget notifies land a tick after the response. */
async function waitForZoho(count, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (received.length < count && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20));
  }
}

async function testClickToDialRoute() {
  console.log("\n[7] Click-to-dial route, with no agent logged in");
  received.length = 0;
  vobizCalls = [];

  // The case that matters: Zoho's click-to-dial is server-to-server, so there
  // is normally no softphone session anywhere. This used to place the call and
  // then throw a TypeError reading `session.from` — the customer's phone rang
  // while Zoho got a 500 and no call state was ever reported.
  const res = await clickToDial();
  const body = await res.json();

  check("the route answers 200, not a 500", res.status === 200, { status: res.status, body });
  check("Zoho is given a call id", typeof body.callid === "string" && body.callid.length > 0, body);
  check("a call was actually placed through VoBiz", vobizCalls.length === 1, vobizCalls);
  check("it dials the requested number", vobizCalls[0] && vobizCalls[0].to === "+919999900001", vobizCalls[0]);
  check("it falls back to the account caller ID", vobizCalls[0] && vobizCalls[0].from === "+91XXXXXXXXXX", vobizCalls[0]);

  await waitForZoho(1);
  const ringing = received.find(r => r.fields.state === "ringing");
  check("Zoho is told the call is ringing", Boolean(ringing), received.map(r => r.fields));
  check("the ringing notify carries the account caller ID, not undefined",
    ringing && ringing.fields.from === "+91XXXXXXXXXX", ringing && ringing.fields);
  check("the notified call id matches the one Zoho was handed",
    ringing && ringing.fields.id === body.callid, { notified: ringing && ringing.fields.id, returned: body.callid });
}

async function testClickToDialErrorReporting() {
  console.log("\n[8] Failed dials are reported to Zoho (clicktodialerror)");

  received.length = 0;
  vobizCalls = [];
  const unknownAgent = await clickToDial({ agentId: "nobody" });
  await waitForZoho(1);
  const reported = received.find(r => r.path.startsWith("/phonebridge/v3/clicktodialerror"));
  check("an unknown agent still answers the request", unknownAgent.status === 400, unknownAgent.status);
  check("no call is placed for it", vobizCalls.length === 0, vobizCalls);
  check("Zoho is told the dial failed", Boolean(reported), received.map(r => r.path));
  check("the error carries from/to/code", reported && reported.fields.to === "+919999900001" &&
    Boolean(reported.fields.from) && Boolean(reported.fields.code), reported && reported.fields);
  check("it is form-encoded like every other PhoneBridge call",
    reported && (reported.contentType || "").includes("x-www-form-urlencoded"), reported && reported.contentType);

  received.length = 0;
  vobizCalls = [];
  const rejected = await clickToDial({ to: "+910000000000" });
  await waitForZoho(1);
  const rejectReport = received.find(r => r.path.startsWith("/phonebridge/v3/clicktodialerror"));
  check("a call VoBiz rejects is reported too", Boolean(rejectReport), received.map(r => r.path));
  check("and the request itself fails rather than pretending", rejected.status >= 400, rejected.status);
  check("no ringing state is sent for a call that never started",
    !received.some(r => r.fields.state === "ringing"), received.map(r => r.fields));
}

async function testUnansweredCallIsLogged() {
  console.log("\n[9] A call nobody answered is still logged");
  received.length = 0;

  const callUuid = "mock-uuid-unanswered";
  pb.trackCall(callUuid, {
    orgId: TEST_ORG_ID, callId: `vobiz-${callUuid}`, agentId: "test-agent",
    type: "dialed", from: "+91XXXXXXXXXX", to: "+919999900001",
    startedAtMs: Date.now() - 35_000,   // rang for 35s, never picked up
  });

  await backend.finalizeZohoPhoneBridgeCall(callUuid, { agentId: "test-agent" });

  const logged = received.find(r => r.path.startsWith("/phonebridge/v3/callnotify"));
  check("the call log reached Zoho", Boolean(logged), received.map(r => r.path));
  check("it is accepted, not 400-rejected as 'missed'", logged && logged.fields.state === "ended", logged && logged.fields);
  check("ring time is not billed as talk time", logged && logged.fields.duration === "0", logged && logged.fields);
  check("finalizing twice sends nothing the second time", await (async () => {
    const before = received.length;
    await backend.finalizeZohoPhoneBridgeCall(callUuid, { agentId: "test-agent" });
    return received.length === before;
  })());
}

async function testDialResultAndDoubleAnswer() {
  console.log("\n[10] VoBiz callback contract — found by a live call, 16 Sep");
  received.length = 0;

  const callUuid = "mock-uuid-double-answer";
  pb.trackCall(callUuid, {
    orgId: TEST_ORG_ID, callId: `vobiz-${callUuid}`, agentId: "test-agent",
    type: "dialed", from: "+91XXXXXXXXXX", to: "+919999900001",
  });

  const answer = () => realFetch(`http://127.0.0.1:${backendPort}/answer?agentId=test-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ CallUUID: callUuid, From: "+91XXXXXXXXXX" }).toString(),
  });

  const first = await answer();
  const firstXml = await first.text();
  await waitForZoho(1);
  const answeredAt = pb.getTrackedCall(callUuid).answeredAtMs;
  check("the answer webhook returns Dial XML", firstXml.includes("<Dial"), firstXml.slice(0, 80));
  check("Zoho is told the call was answered", received.filter(r => r.fields.state === "answered").length === 1,
    received.map(r => r.fields.state));

  // VoBiz can fetch the answer URL twice for one call. It must not become two
  // calls as far as Zoho is concerned, and it must not move the clock the
  // final duration is measured from.
  await answer();
  await new Promise(r => setTimeout(r, 150));
  check("a second answer webhook is NOT reported to Zoho again",
    received.filter(r => r.fields.state === "answered").length === 1,
    received.map(r => r.fields.state));
  check("the original answer time is kept", pb.getTrackedCall(callUuid).answeredAtMs === answeredAt);

  // /dial-result is a Dial `action` URL with redirect="false". VoBiz's docs
  // require an empty <Response></Response>; answering JSON made it re-run the
  // whole answer document after the Dial had already finished.
  const dialResult = await realFetch(`http://127.0.0.1:${backendPort}/dial-result?agentId=test-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ CallUUID: callUuid, DialStatus: "busy", DialHangupCause: "USER_BUSY" }).toString(),
  });
  const body = await dialResult.text();
  check("dial-result answers XML, not JSON",
    (dialResult.headers.get("content-type") || "").includes("xml"), dialResult.headers.get("content-type"));
  check("and it is an empty <Response></Response>",
    /<Response>\s*<\/Response>/.test(body), body.slice(0, 120));

  // VoBiz posts Event=Hangup to the answer URL when no hangup_url is set. It
  // must be acknowledged with an empty document, never with call instructions.
  const hangupAck = await realFetch(`http://127.0.0.1:${backendPort}/answer?agentId=test-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ CallUUID: callUuid, Event: "Hangup", CallStatus: "completed" }).toString(),
  });
  const hangupBody = await hangupAck.text();
  check("a Hangup event is acknowledged, not answered with <Dial>",
    /<Response>\s*<\/Response>/.test(hangupBody) && !hangupBody.includes("<Dial"), hangupBody.slice(0, 120));

  // An answered call is logged with VoBiz's billed duration, not the length of
  // the recording — a live call reported 2s for a call the CDR billed at 4.
  received.length = 0;
  const answeredUuid = "mock-uuid-billed";
  pb.trackCall(answeredUuid, {
    orgId: TEST_ORG_ID, callId: `vobiz-${answeredUuid}`, agentId: "test-agent",
    type: "dialed", from: "+91XXXXXXXXXX", to: "+919999900001",
    startedAtMs: Date.now() - 40_000, answeredAtMs: Date.now() - 38_000,
  });
  await backend.finalizeZohoPhoneBridgeCall(answeredUuid, { agentId: "test-agent", durationSec: 2 });
  const billed = received.find(r => r.path.startsWith("/phonebridge/v3/callnotify"));
  check("an answered call is logged with the CDR's billed duration, not the recording length",
    billed && billed.fields.duration === "37", billed && billed.fields);

  pb.untrackCall(callUuid);
}

function stopBackend() {
  if (realFetch) globalThis.fetch = realFetch;
  if (createdAgentsFile) { try { fs.unlinkSync(AGENTS_FILE); } catch { /* already gone */ } }
  if (!backend) return Promise.resolve();
  return new Promise(resolve => backend.server.close(resolve));
}

// --- Runner ----------------------------------------------------------------

(async () => {
  console.log("Zoho PhoneBridge — end-to-end test against a mock Zoho\n" + "=".repeat(58));
  const server = await startMockZoho();
  console.log(`Mock Zoho listening on http://127.0.0.1:${MOCK_PORT}`);
  seedTestOrg();

  try {
    await testServerInfo();
    await testTimeFormat();
    await testOutboundLifecycle();
    await testInboundAndMissed();
    await testClickToDialRegistration();
    await testMultiTenancy();
    await startBackend();
    await testClickToDialRoute();
    await testClickToDialErrorReporting();
    await testUnansweredCallIsLogged();
    await testDialResultAndDoubleAnswer();
  } catch (err) {
    fail += 1;
    console.error("\nUnexpected error:", err);
  } finally {
    await stopBackend();
    removeTestOrg();
    // Wait for the socket to actually close before setting an exit code.
    // Calling process.exit() while libuv is still tearing the handle down
    // trips an assertion on Windows that looks like a test failure.
    await new Promise(resolve => server.close(resolve));
  }

  console.log("\n" + "=".repeat(58));
  console.log(`${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
