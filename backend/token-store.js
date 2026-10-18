"use strict";

/**
 * Persistent, encrypted, per-organization store for Zoho OAuth grants.
 *
 * One JSON file, keyed by our own org id. Every record keeps its non-secret
 * fields (datacentre, api domain, click-to-dial registration, agent mapping)
 * in the clear so the file is inspectable, and its two secrets — the access
 * token and the refresh token — sealed with AES-256-GCM:
 *
 *   "refreshToken": "v1:<iv b64>:<tag b64>:<ciphertext b64>"
 *
 * The org id and field name are bound in as additional authenticated data, so
 * a ciphertext copied from one org's record into another's fails to decrypt
 * rather than quietly granting the second org the first one's Zoho access.
 *
 * The key comes from TOKEN_ENCRYPTION_KEY: 32 bytes, as 64 hex characters or
 * base64. Without it nothing is written — a store that silently fell back to
 * plaintext would be worse than one that refuses.
 *
 * Writes go to a temporary file and are renamed into place, so a crash halfway
 * through a write leaves the previous file intact. The file is created 0600.
 *
 * Put the file on a disk that survives a restart (DATA_DIR). That, not an
 * environment variable holding one refresh token, is what keeps every
 * connected org across a redeploy.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SECRET_FIELDS = ["accessToken", "refreshToken"];
const PREFIX = "v1:";

const KEY_HINT =
  "generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"";

function parseKey(raw) {
  if (!raw) throw new Error(`TOKEN_ENCRYPTION_KEY is not set — ${KEY_HINT}`);
  const value = String(raw).trim();
  const buf = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (buf.length !== 32) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64) — ${KEY_HINT}`);
  }
  return buf;
}

function seal(plaintext, key, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

function open(blob, key, aad) {
  const [ivB64, tagB64, ctB64] = blob.slice(PREFIX.length).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

const isSealed = v => typeof v === "string" && v.startsWith(PREFIX);

/**
 * @param {object} opts
 * @param {string} opts.file   where the store lives
 * @param {string} [opts.key]  raw TOKEN_ENCRYPTION_KEY; read from env when omitted
 */
function createTokenStore({ file, key } = {}) {
  const filePath = () => file || path.join(process.env.DATA_DIR || __dirname, "zoho-orgs.json");
  const keyBuf = () => parseKey(key || process.env.TOKEN_ENCRYPTION_KEY);

  function readRaw() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath(), "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      if (err.code !== "ENOENT") console.error(`[token-store] could not read ${filePath()}: ${err.message}`);
      return {};
    }
  }

  function writeRaw(all) {
    const target = filePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
  }

  function decryptRecord(orgId, rec) {
    if (!rec) return null;
    const out = { ...rec };
    for (const field of SECRET_FIELDS) {
      const v = rec[field];
      if (v == null) continue;
      if (isSealed(v)) {
        try {
          out[field] = open(v, keyBuf(), `${orgId}|${field}`);
        } catch {
          throw new Error(`could not decrypt ${field} for org "${orgId}" — wrong TOKEN_ENCRYPTION_KEY, or the record was tampered with`);
        }
      }
      // A plaintext value (written by an older version) is returned as-is and
      // sealed on the next write.
    }
    return out;
  }

  function encryptRecord(orgId, rec) {
    const out = { ...rec };
    for (const field of SECRET_FIELDS) {
      const v = rec[field];
      if (v == null || v === "") continue;
      out[field] = seal(v, keyBuf(), `${orgId}|${field}`);
    }
    return out;
  }

  return {
    filePath,
    get(orgId) {
      if (!orgId) return null;
      const all = readRaw();
      return Object.prototype.hasOwnProperty.call(all, orgId) ? decryptRecord(orgId, all[orgId]) : null;
    },
    put(orgId, patch) {
      if (!orgId || typeof orgId !== "string") throw new Error("orgId is required");
      keyBuf(); // fail before touching the file when no key is configured
      const all = readRaw();
      const existing = Object.prototype.hasOwnProperty.call(all, orgId) ? decryptRecord(orgId, all[orgId]) : {};
      const merged = { ...existing, ...patch, orgId, updatedAt: new Date().toISOString() };
      all[orgId] = encryptRecord(orgId, merged);
      writeRaw(all);
      return merged;
    },
    remove(orgId) {
      const all = readRaw();
      if (!Object.prototype.hasOwnProperty.call(all, orgId)) return false;
      delete all[orgId];
      writeRaw(all);
      return true;
    },
    /** Every record, secrets stripped — for listings that must never echo a token. */
    listPublic() {
      return Object.values(readRaw()).map(rec => {
        const out = { ...rec };
        for (const field of SECRET_FIELDS) delete out[field];
        return out;
      });
    },
    /** Raw on-disk form, for tests that assert nothing is stored in the clear. */
    _raw: readRaw,
  };
}

module.exports = { createTokenStore, parseKey, seal, open };
