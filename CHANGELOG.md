# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
