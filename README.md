<div align="center">

# Vobiz Calling for Zoho

**Vobiz as a Zoho PhoneBridge telephony provider. Agents click a number anywhere in Zoho, the call is placed on Vobiz, and the call log lands on the Zoho record with its recording.**

[![License: MIT](https://img.shields.io/badge/License-MIT-e83c00.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/Node-18%2B-339933.svg)](https://nodejs.org)

[Docs](https://www.vobiz.ai/docs/integrations/zoho) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

</div>

---

## What it does

| | |
| --- | --- |
| **Click-to-dial** | A user clicks a number in Zoho and the call is placed. |
| **Call states** | `ringing` / `answered` / `ended` reported as they happen. |
| **Call logging** | Inbound and outbound written to the Zoho record. |
| **Recordings** | Delivered to the call log behind a signed URL. |
| **Failed dials** | Reported to Zoho as `clicktodialerror`. |
| **Browser audio** | Outbound and inbound, with an Accept / Decline banner. |

Zoho requires click-to-dial, call logging and call states of any provider.
Transfers (blind and warm) and ringing groups (parallel and sequential) are
optional extras in the PhoneBridge specification and are **not built yet**.

## What PhoneBridge is

Zoho PhoneBridge is Zoho's programme for telephony providers. Once live, Vobiz
appears as a selectable phone system across Zoho CRM, Desk, Recruit, Bigin and
Zoho One.

**There is no widget to build.** Zoho draws the entire user interface — its own
call bar, its own incoming-call pop-up — and Vobiz runs underneath as the
engine. The integration is **server-to-server**: this service exposes an
endpoint Zoho calls when a user clicks a phone number, and reports call state
back as the call progresses.

Two consequences shape everything else:

- **Multi-tenant.** Every Zoho customer who installs Vobiz is a tenant, so
  credentials are stored per organization, never globally.
- **Multi-region.** Zoho runs **11 datacentres** and a customer's data lives in
  exactly one. Domains are resolved at runtime, never hardcoded.

## The call flow

The agent's browser leg comes up **first**, which is what Zoho's click-to-dial
specification asks for.

```
 Zoho user clicks a phone number
            │
            ▼
 Zoho POSTs `tonumber` to the click-to-dial endpoint
            │
            ▼
 The number is handed to the agent's softphone over /call-events
            │
            ▼
 The browser sends the INVITE, then Vobiz dials the customer
            │
            ├─► callnotify: ringing    ──► Zoho shows its call bar
            ├─► callnotify: answered   ──► Zoho updates the bar
            ▼
 Call ends → callnotify: ended + duration + recording URL
                                       ──► the log lands on the record
```

`BROWSER_FIRST_DIAL=false` reverts to customer-first dialling, where Vobiz
places the call to the customer over the REST API and bridges the agent in once
they answer. The trade-off is audible: the customer hears a few seconds of
ringback *after* answering.

Inbound rings the softphone with an **Accept / Decline** banner rather than
answering automatically — Enter accepts, Escape declines. The agent has 20
seconds before the caller falls through to voicemail. `INBOUND_RECORD=true`
records inbound sessions.

## Connecting a Zoho organization

```
1. GET accounts.zoho.com/oauth/serverinfo      → the 11 datacentre domains
2. customer consents; redirect returns code + location
3. POST accounts.zoho.<dc>/oauth/v2/token      → access + refresh, api_domain
4. POST {api_domain}/phonebridge/v3/integrate  → activate the PBX
5. POST {api_domain}/phonebridge/v3/clicktodial
6. GET  {api_domain}/phonebridge/v3/users      → zohouser ids
```

> **Step 4 is not in Zoho's V3 documentation, and nothing works without it.**
> Until `integrate` is called once for an organization, every other PhoneBridge
> endpoint rejects that org with `PBX_NOT_INTEGRATED` — including
> `clicktodial`, `callnotify` and `users`. Zoho's own screens report the
> opposite while this is outstanding: Marketplace → Telephony shows the provider
> as installed, and CRM offers "View Configuration". Installed according to the
> UI, not integrated according to the API. The call takes no parameters and is
> idempotent.

Step 1 matters more than it looks: Zoho forbids hardcoding domains, and getting
it wrong is grounds for rejection.

## The API contract

Base `{api_domain}/phonebridge/v3/` — `api_domain` comes from the token
response, never hardcoded. Bodies are form-encoded.

**The auth header is `Zoho-oauthtoken <token>`.** `Bearer` returns 401.

| Endpoint | Purpose | Required params |
|---|---|---|
| `POST integrate` | Activate the PBX. Must be first | none |
| `POST clicktodial` | Register where Zoho sends dial requests | `clicktodialuri` |
| `DELETE clicktodial` | Deregister | none |
| `GET users` | List Zoho users with their `zohouser` ids | none |
| `POST callnotify` | Report a call state change | `type`, `state`, `id`, `from`, `to` |
| `POST clicktodialerror` | Report a failed dial | `from`, `to`, `code` |

### Call states, verified against the live API

| state | Extra params | `type=dialed` | `type=received` |
|---|---|---|---|
| `ringing` | — | 200 | 200 |
| `answered` | — | 200 | 200 |
| `ended` | `start_time`, `duration`, `voiceuri` | 200 | 200 |
| `missed` | with and without | **400** | **400** |
| `busy` `rejected` `notavailable` `noanswer` | with and without | **400** | **400** |

`missed` is documented by Zoho but rejected by their live API, as is every
other terminal state except `ended`. A missed call is therefore logged as a
zero-length completed call.

### Timestamp format

```
start_time = "2026-09-15 12:00:00"       ← yyyy-MM-dd HH:mm:ss, GMT
start_time = "2026-09-15T12:00:00.000Z"  ← ISO 8601 is REJECTED
```

## Running the agent softphone

```bash
cd backend && npm start
open "$PUBLIC_BASE_URL/agent-phone?agentId=test-agent"
```

Allow the microphone and wait for the green dot. The page is served from the
backend so it shares an origin with the API and the SSE stream.

## Notes and gotchas

Things that cost real debugging time. Read before changing anything.

**`callerId` on `<Dial>` is mandatory, not cosmetic.** Omit it and Vobiz refuses
to create the agent leg *at all* — no dial-leg CDR, the call runs ~3 seconds and
falls through to the fallback message. On an inbound call Vobiz would otherwise
derive it from the A leg, which is the caller's own number and not one the
account owns.

**Ask for the microphone before the call, never during.** If the browser's
permission prompt appears while a call is ringing, the agent reads a dialog
while the SIP session waits for media, and the leg is torn down before Allow is
clicked.

**`session.connection` is null on an incoming SIP session.** Reading it throws
inside the `newRTCSession` handler and aborts it before `answer()` — the call
rings in the browser forever. Bind audio via the `peerconnection` event instead.

**Recordings need a signed URL, and the account credentials behind it.** Zoho
fetches `voiceuri` with no Vobiz credentials of its own, and comes back for the
audio long after any agent session has gone. The HMAC signature is what
authenticates the request; the fetch itself runs server-side.

**Ephemeral filesystems wipe state.** The stored org does not survive a restart
on hosts with an ephemeral disk. Set `ZOHO_PB_REFRESH_TOKEN` and
`ZOHO_PB_ORG_LOCATION` and the backend rebuilds the org at boot.

**Ignore `sip_registered`.** It never flips to `"true"` for WebSocket
registrations, on any endpoint — not for stock JsSIP, and not for the endpoint
behind Vobiz's own demo. It is not evidence of anything. Gate on JsSIP's
`registered` event.

Three JsSIP settings are **required** and each fails in a way that points
nowhere near the cause:

| Setting | Symptom without it |
|---|---|
| `session_timers: false` | `422`, surfaced as the opaque cause "SIP Failure Code", and no CDR at all |
| `pcConfig.iceServers` | host-only candidates, "Incompatible SDP", CDR billed `0s` |
| space-free `user_agent` | Vobiz interpolates it unescaped into a gateway URI; JsSIP's default contains a space |

## Known limitations

- **A missed call is logged as a zero-length completed call**, because Zoho's
  live API rejects every other terminal state.
- **Single-tenant token storage.** Works for one org; real multi-tenant
  operation needs a database with encryption at rest.
- **No Zoho-user → Vobiz-agent mapping.** One registration serves one agent.
  The `zohouser` ids are obtainable, so per-user addressing is buildable — it is
  also the prerequisite for transfers and ringing groups.
- **No transfers or ringing groups.**

This is a working integration, not a finished product. Read
[SECURITY.md](SECURITY.md) before putting it in front of real customer traffic.

## Documentation

Full guide: **https://www.vobiz.ai/docs/integrations/zoho**

Zoho's own reference: **https://www.zoho.com/phonebridge/developer/v3/**

## License

[MIT](LICENSE)
