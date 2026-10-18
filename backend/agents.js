"use strict";

/**
 * The agents this backend knows, and which Zoho user each one is.
 *
 * agents.json (AGENTS_FILE, or DATA_DIR/agents.json, or beside this file):
 *
 *   {
 *     "priya": {
 *       "displayName": "Priya",
 *       "sipUser": "priya123@registrar.vobiz.ai",
 *       "sipPassword": "…",
 *       "callerId": "+9180XXXXXXXX",          optional, else VOBIZ_FROM_NUMBER
 *       "phoneNumber": "+9198XXXXXXXX",       optional, offline fallback only
 *       "zohoUser": "60083148163",            optional — explicit mapping
 *       "email": "priya@example.com"          optional — matched to Zoho's roster
 *     }
 *   }
 *
 * A missing or unreadable file is an empty roster, logged once — never an
 * exception thrown from inside a request handler, which is what used to take
 * the whole process down on the first GET /agent/... .
 */

const fs = require("fs");
const path = require("path");

const agentsFile = () =>
  process.env.AGENTS_FILE || path.join(process.env.DATA_DIR || __dirname, "agents.json");

let cache = { file: null, mtimeMs: -1, agents: {} };
let warned = false;

function loadAgents() {
  const file = agentsFile();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    if (!warned) {
      console.warn(`[agents] ${file} not found — no agents configured. Copy agents.example.json to agents.json.`);
      warned = true;
    }
    return {};
  }
  if (cache.file === file && cache.mtimeMs === stat.mtimeMs) return cache.agents;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const agents = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    cache = { file, mtimeMs: stat.mtimeMs, agents };
    warned = false;
    return agents;
  } catch (err) {
    console.error(`[agents] ${file} is not valid JSON: ${err.message}`);
    return {};
  }
}

/** Own properties only, so "__proto__" or "constructor" never resolve to an agent. */
function getAgent(agentId) {
  if (!agentId || typeof agentId !== "string") return null;
  const agents = loadAgents();
  return Object.prototype.hasOwnProperty.call(agents, agentId) ? agents[agentId] : null;
}

/**
 * Pair agents with Zoho users from GET /phonebridge/v3/users.
 * An explicit `zohoUser` wins; otherwise the agent's `email` is matched,
 * case-insensitively, to the Zoho user's email.
 *
 * @returns {{ map: Record<string,string>, unmatchedAgents: string[], unmatchedZohoUsers: object[] }}
 */
function matchAgentsToZohoUsers(agents, zohoUsers) {
  const users = Array.isArray(zohoUsers) ? zohoUsers : [];
  const byId = new Map(users.map(u => [String(u.zohouser), u]));
  const byEmail = new Map(users.filter(u => u.email).map(u => [String(u.email).toLowerCase(), u]));
  const map = {};
  const unmatchedAgents = [];
  for (const [agentId, agent] of Object.entries(agents || {})) {
    let hit = null;
    if (agent && agent.zohoUser && byId.has(String(agent.zohoUser))) hit = byId.get(String(agent.zohoUser));
    else if (agent && agent.zohoUser && users.length === 0) hit = { zohouser: String(agent.zohoUser) };
    else if (agent && agent.email) hit = byEmail.get(String(agent.email).toLowerCase()) || null;
    if (hit) map[agentId] = String(hit.zohouser);
    else unmatchedAgents.push(agentId);
  }
  const mapped = new Set(Object.values(map));
  const unmatchedZohoUsers = users.filter(u => !mapped.has(String(u.zohouser)));
  return { map, unmatchedAgents, unmatchedZohoUsers };
}

/** Reverse lookup on an org's stored mapping. */
function agentForZohoUser(agentMap, zohoUser) {
  if (!zohoUser || !agentMap) return null;
  const hit = Object.entries(agentMap).find(([, z]) => String(z) === String(zohoUser));
  return hit ? hit[0] : null;
}

module.exports = { loadAgents, getAgent, matchAgentsToZohoUsers, agentForZohoUser, agentsFile };
