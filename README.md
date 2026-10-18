<div align="center">

# Vobiz Calling for Zoho

**Vobiz as a Zoho PhoneBridge telephony provider. Agents click a number anywhere in Zoho, the call is placed on Vobiz, and the call log lands on the Zoho record with its recording.**

[![License: MIT](https://img.shields.io/badge/License-MIT-e83c00.svg)](LICENSE)
[![Node 20.12+](https://img.shields.io/badge/Node-20.12%2B-339933.svg)](https://nodejs.org)

[Docs](https://www.vobiz.ai/docs/integrations/zoho) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

</div>

---

## What it does

| | |
| --- | --- |
| **Click-to-dial** | A user clicks a number in Zoho and the call is placed. |
| **Call states** | `ringing` / `answered` / `ended` reported as they happen. |
| **Call logging** | Inbound and outbound written to the Zoho record, against the Zoho user who took the call. |
| **Many agents** | Each Zoho user is mapped to a Vobiz agent; click-to-dial is registered per user. |
| **Any Vobiz account** | Agents sign in from the softphone with their own Vobiz Auth ID + Auth Token; the backend sets up their line. No Vobiz credential, SIP login or number lives in `.env` or `agents.json`. |
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

- **Multi-tenant.** Every Zoho organization that connects is a tenant with its
  own record. Tokens are encrypted at rest (AES-256-GCM) and kept on disk under
  `DATA_DIR`, so they survive a restart.
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

If the agent has no softphone open, or has not signed in to Vobiz there, the
click is refused and Zoho is told `AGENT_OFFLINE`. (The old
`CLICKTODIAL_WHEN_OFFLINE=phone` fallback is gone: it needed a Vobiz account
and a phone number configured on the server.)

Inbound: a PSTN call to a DID reaches `/answer`, the account is identified by
the webhook's `ParentAuthID` (falling back to which signed-in account owns the
dialled `To`), and every signed-in agent of that account rings at once. A
number nobody is signed in for gets a polite message and a hangup. Inbound rings the softphone with an **Accept / Decline** banner rather than
answering automatically — Enter accepts, Escape declines. The agent has 20
seconds before the caller falls through to voicemail. `INBOUND_RECORD=true`
records inbound sessions.

## Setup

```bash
cd backend
cp .env.example .env            # deployment config only — no Vobiz credentials
cp agents.example.json agents.json
npm test                        # hermetic: no network, no real accounts
npm start
```

1. **Agents.** One entry per agent in `agents.json`: a `displayName` and either
   `zohoUser` (the Zoho PhoneBridge user id) or `email` (matched to the Zoho
   user's email). Nothing else — no SIP login, password or number.
2. **Vobiz.** Nothing to set up by hand for agents who sign in with their Vobiz
   account (see [Signing in to Vobiz](#signing-in-to-vobiz)).
3. **Zoho OAuth client.** The client's redirect URI must be
   `<PUBLIC_BASE_URL>/oauth/zoho/callback`, and `ZOHO_PB_REDIRECT_URI` must
   match it exactly.
4. **Connect an org** (admin). Sign in at `/admin/login` with `ADMIN_TOKEN`,
   open `/zoho/phonebridge/connect`, approve in Zoho. The callback stores the
   org and returns its `orgId`.
5. **Register** (admin):
   `curl -X POST $PUBLIC_BASE_URL/zoho/phonebridge/register -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"orgId":"org_..."}'`
   This activates the PBX, reads the org's Zoho users, pairs them with agents
   and registers one click-to-dial URI per pair. The response lists anyone left
   unmatched. Pass `"defaultAgentId"` to also register an org-level URI.
6. **Agents sign in.** `GET /admin/agent-links` (admin) returns one link per
   agent. Each agent opens theirs once; the key in the link is exchanged for a
   session cookie and removed from the address bar. The softphone then asks
   them to sign in to Vobiz.

A Zoho org is not tied to a Vobiz account. Each click-to-dial goes out on
whichever Vobiz account (or SIP endpoint) that agent signed in with.

## Signing in to Vobiz

The softphone has two tabs.

**Vobiz account** (recommended). The agent types their Vobiz **Auth ID** and
**Auth Token**. The backend:

1. checks the pair with `GET /Account/{auth_id}/numbers` — a wrong pair is a
   401 with a clear message;
2. finds this integration's application in that account (the one whose
   `answer_url` is `<PUBLIC_BASE_URL>/answer`) or creates it
   (`answer_url` `/answer`, `hangup_url` `/hangup`, both POST). It never
   changes an application it did not create;
3. finds or creates one SIP endpoint for this agent in that account (alias
   `zoho-<agentId>`), sets a fresh random SIP password on every sign-in, and
   binds it to the application (`{"app_id":"<id>"}`, checked by reading the
   endpoint back, then the documented `{"application":<id>}` if needed);
4. hands the SIP login to that browser once. The password is never stored.

Only `{endpointId, username}` per `(authId, agentId)` is written to disk, in
`DATA_DIR/vobiz-endpoints.json` (mode 0600, gitignored). The Auth Token stays
in the backend's memory, keyed by Auth ID; it is never returned to a browser,
logged or written to disk.

The caller ID is a dropdown of the account's **active, voice-enabled** numbers
(List Account Phone Numbers, every page). The backend refuses any caller ID
outside that list, and the panel also sends the choice as the
`X-VH-Caller-ID` SIP header on each call.

**Enable inbound calls** (button under the caller ID) attaches the selected
number to this integration's application
(`POST /numbers/%2B<digits>/application`). It only happens when the agent
presses it, because it moves the number off whatever application answered it
before — the panel names that application first.

**SIP direct.** For an endpoint the customer already has: the agent types its
SIP username and password and a caller-ID number (E.164). The password stays in
the browser; the backend only learns the username and caller ID, and routes
inbound calls to that caller ID to this agent. The customer has to wire Vobiz
themselves:

- **Console:** Voice → Applications → create an application with answer URL
  `<PUBLIC_BASE_URL>/answer` (POST) and hangup URL `<PUBLIC_BASE_URL>/hangup`;
  open the endpoint and select that application; for inbound, open the number
  and select the same application.
- **API equivalent:** `POST /api/v1/Account/{auth_id}/Application/`
  `{"app_name":"Vobiz-Zoho-PhoneBridge","answer_url":"<PUBLIC_BASE_URL>/answer","answer_method":"POST"}`,
  then `POST /Endpoint/{endpoint_id}/` `{"application":<app_id>}` and
  `POST /numbers/%2B<digits>/application` `{"application_id":"<app_id>"}`.

In SIP-direct mode there is no account API, so the caller-ID list, "Enable
inbound calls", recording links in the Zoho log and billed duration are not
available — the panel says to sign in with a Vobiz account to use them. Vobiz
itself refuses a caller ID the account does not own. Webhooks for SIP-direct
calls cannot be signature-checked (the backend has no token), so they follow
the unknown-account policy below.

**After a restart** the backend holds no Auth Tokens. Agents sign in again
from the softphone; until one agent of an account has, that account's
recording links answer "sign in again" (503) and its webhooks are treated as
unverifiable.

To remove an org: `POST /zoho/phonebridge/disconnect {"orgId": "..."}` (admin)
deregisters click-to-dial, revokes the refresh token at Zoho and deletes our copy.

## Connecting a Zoho organization — what happens

```
1. GET accounts.zoho.com/oauth/serverinfo      → the 11 datacentre domains
2. customer consents; redirect returns code + location + our signed state
3. POST accounts.zoho.<dc>/oauth/v2/token      → access + refresh, api_domain
4. POST {api_domain}/phonebridge/v3/integrate  → activate the PBX
5. GET  {api_domain}/phonebridge/v3/users      → zohouser ids
6. POST {api_domain}/phonebridge/v3/clicktodial  (once per mapped zohouser)
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

### Call states

Each state takes exactly its documented parameters, and Zoho's live API
enforces that in both directions:

| state | Extra params |
|---|---|
| `ringing` | none — `start_time` here is refused with `INVALID_REQUEST` |
| `answered` | none — same |
| `missed` | `start_time` (mandatory), optional `voiceuri` |
| `ended` | `start_time`, `duration`, optional `voiceuri` |

Unanswered calls are logged as `ended` with duration 0 by default. Set
`ZOHO_PB_SEND_MISSED_STATE=true` to send `missed` instead; if Zoho refuses it,
the call is logged as `ended` anyway.

### Timestamp format

```
start_time = "2026-09-15 12:00:00"       ← yyyy-MM-dd HH:mm:ss, GMT
start_time = "2026-09-15T12:00:00.000Z"  ← ISO 8601 is REJECTED
```

## Running the agent softphone

Open the agent's sign-in link from `/admin/agent-links`, sign in to Vobiz on
one of the two tabs, allow the microphone, and wait for the green dot. A page
reload signs in to Vobiz again (and rotates the SIP password). The page is served from the backend, so it shares
an origin with the API and the event stream.

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
audio long after any agent session has gone. The HMAC signature — over the
Auth ID, agent, recording id and expiry — is what authenticates the request,
so a link for one account can never fetch another's audio; the fetch itself
runs server-side with that account's in-memory token.

**Vobiz app ids are 17 digits**, above `Number.MAX_SAFE_INTEGER`. They are
kept as strings: long integers in Vobiz responses are quoted before
`JSON.parse`, and request bodies are built as text with the id spliced in.

**Webhook signatures use the account's own token.** The backend works out the
account from the SIP username (browser calls), `ParentAuthID` or the dialled
DID (inbound), or the `authId` on its own callback URLs, and checks
`X-Vobiz-Signature-V3` with that account's token. An account with no token in
memory is treated like a bad signature: accepted with a warning by default,
refused with `REQUIRE_VOBIZ_SIGNATURE=true`.

**Put `DATA_DIR` on a persistent disk.** Connected orgs live in
`DATA_DIR/zoho-orgs.json` and endpoint ids in `DATA_DIR/vobiz-endpoints.json`. On a host with an ephemeral filesystem, a restart
without a persistent disk loses them and each org has to reconnect.

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

- **No transfers or ringing groups.** The per-user mapping they need is in
  place.
- **Agent sessions last 12 hours** and live in a signed cookie; there is no
  per-agent revocation short of rotating `APP_SECRET`.
- **Inbound rings every signed-in agent of the account** at once; there is no
  per-number agent assignment yet.
- **Auth Tokens are in memory only.** After a restart, recordings and
  signature checks for an account wait until one of its agents signs in again.
- **One process.** Call state in flight is held in memory, so run a single
  instance; a restart mid-call loses that call's final log entry.

Read [SECURITY.md](SECURITY.md) before deploying.

## Documentation

Full guide: **https://www.vobiz.ai/docs/integrations/zoho**

Zoho's own reference: **https://www.zoho.com/phonebridge/developer/v3/**

## License

[MIT](LICENSE)
