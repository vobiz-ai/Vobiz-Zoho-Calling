"use strict";

/**
 * Authentication for this backend's own routes.
 *
 * Four kinds of caller, four mechanisms:
 *
 *   Admin    (connect an org, register click-to-dial, status)
 *            `Authorization: Bearer <ADMIN_TOKEN>`, or the `vz_admin` cookie
 *            that POST /admin/session sets after the token is typed in once.
 *
 *   Agent    (the softphone fetching its own SIP credentials, the call-event
 *            stream) — an HttpOnly cookie, `vz_agent`, issued by
 *            POST /agent-session in exchange for that agent's key. The key is
 *            HMAC(APP_SECRET, agentId): nothing to store, and an admin hands
 *            it out as a link from GET /admin/agent-links. The cookie names one
 *            agent, so an agent can read only its own credentials.
 *
 *   Zoho     (click-to-dial) — Zoho cannot send our headers, so the URI we
 *            register carries `t=HMAC(APP_SECRET, orgId|agentId)`. A request
 *            without the right token for that org and agent places no call.
 *
 *   OAuth    the `state` parameter is signed and expires, and it carries the
 *            org id the grant is stored under. The callback trusts nothing
 *            else in the query string to decide which org it is writing.
 *
 * Vobiz webhooks are authenticated separately, by Vobiz's own signature (see
 * verifyVobizSignature in server.js).
 */

const crypto = require("crypto");

const AGENT_COOKIE = "vz_agent";
const ADMIN_COOKIE = "vz_admin";
const AGENT_SESSION_MS = 12 * 60 * 60 * 1000;
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const OAUTH_STATE_MS = 15 * 60 * 1000;

const b64url = buf => Buffer.from(buf).toString("base64url");

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createAuth({
  appSecret = process.env.APP_SECRET,
  adminToken = process.env.ADMIN_TOKEN,
  allowedOrigins = process.env.ALLOWED_ORIGINS,
} = {}) {
  if (!appSecret || String(appSecret).length < 32) {
    throw new Error(
      "APP_SECRET must be set to at least 32 random characters — " +
      "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  const origins = new Set(String(allowedOrigins || "").split(",").map(s => s.trim()).filter(Boolean));

  const mac = (purpose, value) =>
    crypto.createHmac("sha256", appSecret).update(`${purpose}\n${value}`).digest("base64url");

  function signedValue(purpose, payload, ttlMs) {
    const exp = Date.now() + ttlMs;
    const body = `${b64url(payload)}.${exp}`;
    return `${body}.${mac(purpose, body)}`;
  }

  function readSigned(purpose, token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const [payloadB64, exp, sig] = parts;
    if (!safeEqual(sig, mac(purpose, `${payloadB64}.${exp}`))) return null;
    if (!(Number(exp) > Date.now())) return null;
    try {
      return Buffer.from(payloadB64, "base64url").toString("utf8");
    } catch {
      return null;
    }
  }

  const cookie = (name, value, maxAgeMs, secure) =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}` +
    (secure ? "; Secure" : "");

  const isHttps = req =>
    Boolean(req.socket && req.socket.encrypted) ||
    String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";

  return {
    // --- agents ---
    agentKey: agentId => mac("agent-key", agentId),
    verifyAgentKey(agentId, key) {
      return Boolean(agentId) && safeEqual(key, mac("agent-key", agentId));
    },
    agentCookie(req, agentId) {
      return cookie(AGENT_COOKIE, signedValue("agent-session", agentId, AGENT_SESSION_MS), AGENT_SESSION_MS, isHttps(req));
    },
    clearAgentCookie: () => `${AGENT_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    agentFromRequest(req) {
      return readSigned("agent-session", parseCookies(req.headers.cookie)[AGENT_COOKIE]);
    },

    // --- admin ---
    adminConfigured: () => Boolean(adminToken),
    verifyAdminToken: token => Boolean(adminToken) && safeEqual(token, adminToken),
    adminCookie(req) {
      return cookie(ADMIN_COOKIE, signedValue("admin-session", "admin", ADMIN_SESSION_MS), ADMIN_SESSION_MS, isHttps(req));
    },
    isAdmin(req) {
      if (!adminToken) return false;
      const header = String(req.headers.authorization || "");
      if (header.startsWith("Bearer ") && safeEqual(header.slice(7).trim(), adminToken)) return true;
      return readSigned("admin-session", parseCookies(req.headers.cookie)[ADMIN_COOKIE]) === "admin";
    },

    // --- Zoho click-to-dial ---
    clickToDialToken: (orgId, agentId) => mac("clicktodial", `${orgId}|${agentId || ""}`),
    verifyClickToDialToken(orgId, agentId, token) {
      return Boolean(orgId) && safeEqual(token, mac("clicktodial", `${orgId}|${agentId || ""}`));
    },

    // --- OAuth ---
    mintOAuthState: orgId => signedValue("oauth-state", JSON.stringify({ orgId, n: b64url(crypto.randomBytes(9)) }), OAUTH_STATE_MS),
    readOAuthState(state) {
      const raw = readSigned("oauth-state", state);
      if (!raw) return null;
      try {
        const { orgId } = JSON.parse(raw);
        return typeof orgId === "string" && orgId ? orgId : null;
      } catch {
        return null;
      }
    },

    // --- CORS ---
    /**
     * The softphone is served from this backend, so it needs no CORS at all.
     * Anything else must be listed in ALLOWED_ORIGINS; an origin that is not
     * gets no Access-Control-Allow-Origin header, and never `*`.
     */
    applyCors(req, res) {
      const origin = req.headers.origin;
      if (origin && origins.has(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        res.setHeader("Vary", "Origin");
      }
    },
  };
}

module.exports = { createAuth, parseCookies, safeEqual };
