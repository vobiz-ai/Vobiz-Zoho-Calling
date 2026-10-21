# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Found in live testing

- **Answer XML is well-formed.** The `&` between query parameters in `callbackUrl`/`action` attributes is now escaped as `&amp;`. Unescaped, Vobiz rejected the whole answer (hangup cause 8011, "Invalid Answer XML") and every call failed as Busy.
- **The endpoint binding is read from Vobiz's resource URI.** `application` comes back as `/v1/Account/<id>/Application/<appId>/`, so the softphone no longer warns that the endpoint "could not be bound" when it was.
- **Lists are paged 20 at a time.** Vobiz returns at most 20 applications or endpoints per page, whatever `limit` asks for. The lookups now step by what came back, so an account with more than 20 finds this integration's own instead of creating duplicates. A refused application create now names Vobiz's reason.
- **Click-to-dial works through tunnels that hold a stream back.** Cloudflare quick tunnels pass no server-sent events. The event stream now greets with a `hello` event; a softphone that does not get it within 4 s polls `GET /call-events/poll` every 1.5 s instead. An idle stream also gets a keepalive comment every 25 s (`SSE_KEEPALIVE_MS`).

### Integration baseline: one phone line per agent, every outcome logged, hardened callbacks, CI

- **One phone line per agent.** Vobiz keeps one registration per SIP endpoint, so two tabs on one endpoint evict each other.
  - Every sign-in now sets a new SIP password and hands it to that tab only. This replaces the earlier change below in which a second tab reused the live password; the backend no longer keeps any SIP password, even in memory.
  - The agent's other tabs are told **Signed in in another tab**, stop their phone (after a call in progress ends) and offer to sign in again. Tabs are told apart by an id each one sends with its sign-in and its event stream.
  - Click-to-dial goes to the tab holding the line. If that tab is closed, a click is `AGENT_OFFLINE`, never handed to a tab whose password no longer works.
- **Every click-to-dial outcome reaches Zoho.** Before, a click that never became a call left Zoho's call bar ringing. Now it is closed as not connected (`ended`, 0 s, or `missed` with `ZOHO_PB_SEND_MISSED_STATE`) when:
  - the softphone reports it could not place it (`POST /agent/call-failed`, sent on JsSIP `failed`, when not registered, or when the call would not start). An agent can only close their own waiting click; a click already bound to a Vobiz call is logged by that call's webhooks;
  - a newer click replaces it;
  - the agent signs out;
  - nothing happens within `CLICK_TO_DIAL_TIMEOUT_MS` (new, default 2 minutes).

  Zoho always gets `ringing` before the `ended` that closes a click. A clicked call refused at `/answer` for having no caller ID is closed too.
- **Refused calls hear a message, never silence.** A refused `/answer` used to return a bare `<Hangup/>`. It now says the call cannot be connected (browser leg) or that no one is available (inbound).
- **Callbacks trust only what is signed.** `/dial-result` took the agent from `?agentId=`, which the signature does not cover. It now works the agent out from the browser's SIP user or the tracked call. The nonce may also arrive as the plain `X-Vobiz-Signature-Nonce` header.
- **Recordings are fetched only over HTTPS.** The audio URL must be `https://` on a vobiz.ai host before the account's credentials are sent with it.
- **ICE gathering is capped.** The softphone sends its SDP at the first public (server-reflexive) candidate, or 2.5 s after the first candidate, on outbound calls and inbound answers. Before, a machine with extra network adapters could hold a call for about 40 s.
- **`.gitignore`** now lists `vobiz-accounts.json`.
- **CI** (`.github/workflows/ci.yml`): syntax checks of every backend file and the softphone's inline script, plus the tests, on Node 20.12 and 24; and a scan that fails on committed data files, keys, tokens, real-looking Auth IDs, Zoho client IDs, phone numbers and tunnel hosts.
- Tests use obvious fake phone numbers only. Section [13] is rewritten for the new tab behaviour, and a new section [21] covers the above. Tests: 245 → 275 checks.

### Security: crash-proof requests, text-only caller data, signed webhooks, no master key for agents

- **A malformed request can no longer stop the process.** Several requests needed no credentials at all to crash it, wiping every agent's session and every call in progress:
  - a broken `%`-escape in `/agent/<id>` or `/call-events/<id>`;
  - a cookie that is not valid percent-encoding, which any other app on a shared host can set.

  Cookies that cannot be decoded are now skipped, and a malformed path is a `400`. Every route also runs inside an error guard, so a handler that throws or rejects costs only that request a `500`. An unhandled promise rejection is logged instead of stopping the process.
- **The softphone shows caller data as text.**
  - The activity log was written with `insertAdjacentHTML`, so a caller name such as `<img onerror=…>` in an inbound webhook ran script in every ringing agent's tab, where it could read the SIP password and place calls. The log is now built from text nodes.
  - The backend passes on only a plain caller name (otherwise the number) and a call id that looks like one.
  - Click-to-dial accepts only a phone number. Spaces, dashes, dots and brackets are dropped. Anything else is refused, and Zoho is told `INVALID_NUMBER`.
  - The page is served with a strict `Content-Security-Policy`: its own scripts only (the inline one pinned by SHA-256), and network access to this backend and the Vobiz registrar only.
- **Vobiz webhooks must be signed (breaking default).**
  - `REQUIRE_VOBIZ_SIGNATURE` is now on unless set to `false`. Before, a webhook with no or a wrong signature was accepted with a warning, so anyone could send fake call events.
  - The webhook's account is the one whose token verifies the signature, and handlers act for that account only. Before, a customer could sign with their own token, name another customer in `ParentAuthID`, and ring that customer's agents.
  - The parent-account signatures `X-Vobiz-Signature-MA-V3` / `-MA-V2`, which Vobiz adds to sub-account callbacks, are accepted.
  - SIP-direct webhooks, which this backend has no token to check, are accepted unverified only for an agent signed in SIP direct right now.
- **Agents no longer type the account's Auth Token (breaking default).**
  - An admin connects each Vobiz account once, at `/admin/vobiz-account` (a form, or `POST` with JSON). Its token is checked with Vobiz and sealed with `TOKEN_ENCRYPTION_KEY` in `DATA_DIR/vobiz-accounts.json`.
  - Agents sign in from the softphone with nothing to type, on the account assigned to them in `agents.json` (`vobizAccount`), or the only connected account. They cannot pick another.
  - A connected account survives restarts, so its webhooks are verified and its recording links play before any agent signs in again.
  - `POST /admin/vobiz-account/disconnect` deletes the token and signs that account's agents out.
  - Sign-in with a typed Auth Token is refused unless `ALLOW_AGENT_AUTH_TOKEN=true`, which is only for migrating an existing deployment.
- `token-store.js` takes `fileName`, `secretFields` and `idField`, so the same sealed store holds the connected Vobiz accounts.
- Tests: 186 → 245 checks, in four new sections, one per fix. The mock Zoho now listens on a free port instead of a fixed 8094.

### Runs under a path prefix

- Session cookies are scoped to the path of `PUBLIC_BASE_URL` (for example
  `/zoho`), so several services can share one host without seeing or
  overwriting each other's sign-ins. At the root, nothing changes.
- The admin sign-in response points to the connect URL under
  `PUBLIC_BASE_URL`, prefix included.

### Call logging, recording setting, one tab per agent

- Inbound calls are logged in Zoho against the agent who answered, learned
  from the Dial callback's `DialBLegTo` or, failing that, from the softphone
  that accepted (`POST /agent/inbound-answered`). An unanswered inbound call is
  still logged against the first ringing agent mapped to a Zoho user.
- Numbers typed into the softphone are logged in Zoho (dialed → ringing →
  answered → ended, with duration and recording) against the agent's Zoho
  user. A pending click-to-dial now binds only to a call to the same number
  placed within two minutes.
- `OUTBOUND_RECORD` (default on): `false` stops recording outbound calls.
- A second softphone tab signing in while one is open reuses the live SIP
  password instead of rotating it, and Zoho click-to-dial goes to the most
  recently opened tab only; the others are told where it went.
- "Enable inbound calls" names the application the number moves off (ID as
  fallback).
- The softphone asks for the microphone right after sign-in and says clearly
  when it is blocked.

### Any Vobiz account can sign in

- Agents sign in to Vobiz from the softphone, with their own Auth ID + Auth
  Token ("Vobiz account") or an existing endpoint's SIP login + caller ID
  ("SIP direct"). `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN` and `VOBIZ_FROM_NUMBER`
  are gone, and `agents.json` holds only the agent ↔ Zoho user mapping.
- In "Vobiz account" mode the backend finds or creates this integration's
  application and one SIP endpoint per agent in that account, rotates the SIP
  password on each sign-in, and keeps the token in memory only.
- Caller ID is picked from the account's active, voice-enabled numbers; the
  backend refuses anything else. Also sent as `X-VH-Caller-ID`.
- "Enable inbound calls" attaches a number to the provisioned application.
  `/inbound-answer?agentId=` and its hand-made application are no longer
  needed; inbound is routed by `ParentAuthID` / the dialled DID.
- Webhook signatures, CDR lookups and recordings use the right account's
  token; recording links carry the Auth ID inside their signature.
- Removed: `CLICKTODIAL_WHEN_OFFLINE=phone` (it needed server-side Vobiz
  credentials and a phone number per agent).

### Security

- `GET /agent/:id` no longer returns a SIP password unauthenticated. Agents
  sign in with a per-agent key and can read only their own credentials.
- Admin routes need `ADMIN_TOKEN`; click-to-dial needs the HMAC token in its
  registered URI; the OAuth callback needs a signed `state`.
- CORS is an allowlist instead of `*`.
- Two unauthenticated requests that crashed the process are gone (a missing
  `agents.json`, and the leftover `/zoho/connect`).

### Changed

- Zoho tokens are stored per org, encrypted with AES-256-GCM, under
  `DATA_DIR`. Each connect creates its own org, so a second customer no longer
  overwrites the first. `ZOHO_PB_REFRESH_TOKEN` / `ZOHO_PB_ORG_LOCATION` are
  gone.
- Zoho users are mapped to agents (`zohoUser` or `email` in `agents.json`) and
  click-to-dial is registered per user.
- With no softphone open, click-to-dial is refused with `AGENT_OFFLINE`
  instead of placing a call that bridged the agent with `<Dial><User>`.
- `/answer` finds the agent from the SIP username; the endpoint's application
  no longer needs `?agentId=`.
- Browser-originated calls report `answered` and carry their recording and
  the customer leg's billed duration into the Zoho call log.
- Inbound calls are logged to Zoho and ring for 20 seconds.
- `missed` is sent with its mandatory `start_time`.
- HubSpot, Salesforce, Deluge and Vapi leftovers removed.
- Tests are hermetic.

## [1.0.0] — 2026-09-20

First public release.

### Added

- Outbound calling with browser audio over WebRTC.
- Inbound calling with an Accept / Decline prompt.
- Call logging to Zoho, with duration and outcome.
- Recording playback behind an HMAC-signed, short-expiry link that carries no
  credentials.
- Setup, architecture and troubleshooting documentation.

### Notes

- The browser is the A leg: the panel sends the SIP INVITE and the backend
  answers `<Dial><Number>`. Originating to the customer over REST and bridging
  the agent in with `<Dial><User>` does not work — routing into a registered
  WebRTC endpoint is blocked platform-side. Inbound is the exception.
- Single-account by design in this release. See the known limitations in the
  README before deploying for more than one agent.

[1.0.0]: https://github.com/vobiz-ai/Vobiz-Zoho-Calling/releases/tag/v1.0.0
