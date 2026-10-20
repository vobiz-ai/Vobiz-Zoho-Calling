# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
