# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
