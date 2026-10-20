<div align="center">

# Vobiz Calling for Zoho

**Vobiz as your Zoho PhoneBridge telephony provider. Click a number in Zoho, talk in the browser, and the call log lands on the Zoho record with its recording.**

[![License: MIT](https://img.shields.io/badge/License-MIT-e83c00.svg)](LICENSE)
[![Node 20.12+](https://img.shields.io/badge/Node-20.12%2B-339933.svg)](https://nodejs.org)

[Docs](https://www.vobiz.ai/docs/integrations/zoho) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

</div>

---

This is the backend that connects your Zoho organization to Vobiz through
[Zoho PhoneBridge](https://www.zoho.com/phonebridge/developer/v3/). Zoho draws
the whole calling interface: its own call bar and its own call pop-ups. Your
agents keep one Vobiz softphone tab open in the browser, which carries the
audio. You run this backend yourself, on a public HTTPS URL.

> **Early access.** Vobiz does not host this backend for you yet. You deploy it
> on your own server and connect it to the Vobiz Telephony listing in Zoho.
> Email [support@vobiz.ai](mailto:support@vobiz.ai) to get started.

## Features

- **Click-to-dial.** A Zoho user clicks a phone number in Zoho and the call is placed on Vobiz from their browser.
- **Live call states.** Zoho's call bar shows the call as ringing, answered and ended as it happens.
- **Call logging.** Outbound calls (clicked in Zoho or typed into the softphone) and inbound calls are logged in Zoho with start time, duration and direction, against the Zoho user who handled the call.
- **Recordings.** Outbound calls are recorded by default and inbound recording is optional; the call log links to the recording.
- **Inbound ringing.** A call to one of your Vobiz numbers rings every signed-in agent of that Vobiz account, with an **Accept / Decline** prompt and voicemail after 20 seconds.
- **Caller ID choice.** Agents pick the caller ID from a dropdown of their Vobiz account's numbers.
- **Many agents.** Each Zoho user is mapped to an agent, and click-to-dial is registered per user.
- **Two sign-in modes.** **Vobiz account** (an admin connects the account once; agents never see its Auth Token, and everything is set up for them) or **SIP direct** (an endpoint you already have).
- **Failed dials reported.** When a click cannot become a call, Zoho is told why.

Transfers and ringing groups are not available yet.

## How it works

```
  Zoho (CRM)                   Your backend                       Vobiz
  ──────────                   ────────────                       ─────
  user clicks a number ──────► /zoho/phonebridge/clicktodial
                               hands the number to the agent's
                               softphone tab  ─────────────────►  browser places the SIP call
                                                                  Vobiz asks /answer what to do
                               /answer: dial the customer   ◄───
                               with the agent's caller ID  ────►  customer's phone rings
  call bar: ringing  ◄──────── callnotify
  call bar: answered ◄──────── callnotify               ◄──────  /dial-event (customer picked up)
  call log + recording ◄────── callnotify ended         ◄──────  /recording-ready, /dial-result
```

- Zoho calls your backend when a user clicks a number. The backend never needs a widget inside Zoho.
- The agent's browser places the call first, then Vobiz dials the customer.
- Your backend reports each state change back to Zoho, and the final state carries the duration and recording link.
- Inbound calls reach the same `/answer` URL. The backend rings the agents signed in to the Vobiz account that owns the dialled number.
- Zoho data is reached in your organization's own Zoho datacentre, worked out at sign-in. Nothing is hardcoded to one region.
- The backend uses Zoho's PhoneBridge API only. It has no code specific to Zoho CRM, Desk, Recruit or Bigin; calls appear wherever Zoho surfaces PhoneBridge telephony in your organization.

## Requirements

**Vobiz**

- A Vobiz account. An admin connects it once with its **Auth ID** and **Auth Token** (Vobiz Console → **API credentials**). Agents never need them.
- At least one active, voice-enabled phone number on that account, to use as caller ID and for inbound calls.
- Balance on the account. Every call is billed.

**Zoho**

- A Zoho organization with a Zoho CRM edition that supports telephony (PhoneBridge) integrations.
- A Zoho administrator who can install a telephony provider from **Marketplace → Telephony**.
- The **Vobiz Telephony** listing enabled for your organization, and the PhoneBridge OAuth client (client ID and client secret) for it. Both come from Vobiz during early access. A client you register yourself at the Zoho API console does not work: Zoho grants PhoneBridge scopes only to the provider's own client.

**Your server**

- Node.js **20.12 or later**. The backend has no npm dependencies.
- A public **HTTPS** URL for the backend, reachable by both Zoho and Vobiz, for example `https://calling.example.com`.
- A disk that survives restarts, for `DATA_DIR`.

**Agents**

- A current Chrome, Edge or Firefox, with microphone access allowed for the backend's URL.

## Quick start

1. **Get the code.**

   ```bash
   git clone https://github.com/vobiz-ai/Vobiz-Zoho-Calling.git
   cd Vobiz-Zoho-Calling/backend
   ```

2. **Configure the deployment.** `.env` holds deployment settings only. No Vobiz credential goes in it.

   ```bash
   cp .env.example .env
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # APP_SECRET
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # TOKEN_ENCRYPTION_KEY
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # ADMIN_TOKEN
   ```

   Fill in `PUBLIC_BASE_URL`, `APP_SECRET`, `TOKEN_ENCRYPTION_KEY`, `ADMIN_TOKEN`, `DATA_DIR`,
   `ZOHO_PB_CLIENT_ID`, `ZOHO_PB_CLIENT_SECRET` and `ZOHO_PB_REDIRECT_URI`. See
   [Configuration reference](#configuration-reference).

3. **List your agents.** One entry per agent, keyed by an agent ID you choose.

   ```bash
   cp agents.example.json agents.json      # or put it in DATA_DIR/agents.json
   ```

   ```json
   {
     "priya": { "displayName": "Priya", "email": "priya@example.com" },
     "arjun": { "displayName": "Arjun", "zohoUser": "600001" }
   }
   ```

   Each agent needs `email` (matched to the Zoho user's email, case-insensitive) or `zohoUser`
   (the Zoho PhoneBridge user ID). Nothing else: no SIP login, password or number. If you connect
   more than one Vobiz account (step 8), also give each agent `"vobizAccount": "MA_XXXXXXXX"`, the
   account they make and take calls on.

4. **Run it.**

   ```bash
   npm start                                # listens on PORT, default 8092
   curl https://calling.example.com/health  # → ok
   ```

5. **Expose it publicly over HTTPS.** Put it behind your load balancer or reverse proxy, so that
   `PUBLIC_BASE_URL` reaches it. For a trial, a tunnel such as ngrok or cloudflared works.

6. **Install Vobiz Telephony in Zoho.** As a Zoho administrator, open **Marketplace → Telephony**,
   choose **Vobiz Telephony** and install it for your organization.

7. **Sign in as admin.** Open `https://calling.example.com/admin/login` and enter your `ADMIN_TOKEN`.
   The admin session lasts 8 hours.

8. **Connect your Vobiz account.** In the same browser, open
   `https://calling.example.com/admin/vobiz-account`, enter the account's **Auth ID** and **Auth
   Token**, and click **Connect**. The backend checks them with Vobiz, sets up the
   **Vobiz-Zoho-PhoneBridge** application in that account, and stores the token encrypted with
   `TOKEN_ENCRYPTION_KEY`. Your agents never see it. Or with curl:

   ```bash
   curl -X POST https://calling.example.com/admin/vobiz-account \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"authId":"MA_XXXXXXXX","authToken":"YOUR_AUTH_TOKEN"}'
   ```

9. **Connect your Zoho organization.** In the same browser, open
   `https://calling.example.com/zoho/phonebridge/connect` and approve the request in Zoho. The
   page that comes back shows your `orgId`, for example `org_1a2b3c4d5e6f7a8b`. Keep it.

10. **Register click-to-dial.**

   ```bash
   curl -X POST https://calling.example.com/zoho/phonebridge/register \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"orgId":"org_1a2b3c4d5e6f7a8b"}'
   ```

   This activates Vobiz as the organization's phone system, reads your Zoho users, pairs them with
   the agents in `agents.json`, and registers click-to-dial for each pair. The response lists
   `registrations`, plus any `unmatchedAgents` and `unmatchedZohoUsers`. Add
   `"defaultAgentId":"priya"` to also register an organization-wide click-to-dial for one agent.

11. **Hand out agent sign-in links.**

    ```bash
    curl https://calling.example.com/admin/agent-links -H "Authorization: Bearer $ADMIN_TOKEN"
    ```

    Each agent gets one link, ending in `#agent=…&key=…`. Send each agent their own link privately.
    It works like a password.

12. **Agents sign in.** Each agent opens their link, clicks **Sign in** (see below), and keeps the
    tab open. The green dot and **Ready** mean they can take and make calls.

Each Zoho organization you connect is kept separately. A Zoho organization is not tied to one
Vobiz account: each call uses the Vobiz account the agent signs in on (the one assigned to them, or
the only connected one), or their SIP endpoint.

## Sign in

Opening the sign-in link starts a 12-hour agent session in that browser. The softphone then
shows **Sign in to Vobiz** with two tabs.

### Vobiz account (recommended)

There is nothing to type. Once an admin has connected the account ([Quick start](#quick-start)
step 8), the softphone names it and the agent clicks **Sign in**. The backend then:

1. Picks the account: the one assigned to the agent in `agents.json` (`vobizAccount`), or the only
   connected account. The agent cannot choose another one. With no account for them, the softphone
   says **No Vobiz account is connected for you yet**.
2. Checks the stored credentials with Vobiz again, so a token revoked in the Vobiz Console stops
   working here too.
3. Finds or creates one application in that account named **Vobiz-Zoho-PhoneBridge**, with
   answer URL `https://calling.example.com/answer` and hangup URL
   `https://calling.example.com/hangup` (both POST). It only reuses an application whose answer URL
   is exactly that, and never changes any other application.
4. Finds or creates one SIP endpoint for this agent in that account (alias `zoho-<agentId>`),
   gives it a fresh random SIP password, and attaches it to that application. A new password is
   set on every sign-in, unless the agent already has a softphone tab open (see
   [More than one tab](#more-than-one-tab)).
5. Starts the softphone with that SIP login, and asks the browser for the microphone straight away,
   so the permission prompt never interrupts a call. If the microphone is blocked, the softphone
   says **Microphone blocked — calls will have no audio**.

**The old sign-in, with the Auth Token.** Earlier versions had each agent type the account's Auth
ID and Auth Token into the softphone. That hands every agent the account's master key, so it is
now refused: the softphone shows no token fields, and the backend answers **Agents do not sign in
with the account's Auth Token here**. Set `ALLOW_AGENT_AUTH_TOKEN=true` only while you move an
existing deployment over, then connect the account and remove it.

**Caller ID.** The **Caller ID** dropdown lists the account's active, voice-enabled numbers. The
agent's last choice is remembered while the backend runs; otherwise the first number is used. The
backend refuses a caller ID that is not on the account.

**Enable inbound calls.** Choose a number in the dropdown and click **Enable inbound calls on this
number**. This attaches the number to the **Vobiz-Zoho-PhoneBridge** application, so calls to it
ring your agents. It moves the number off the application that answered it before, so the
softphone asks first and names that application (by name, or by ID if it has none). Numbers already routed to this integration
show **· inbound on** in the dropdown. Nothing changes on a number until someone clicks the button.

**Sign out of Vobiz** ends the Vobiz session for that agent.

### SIP direct

For an endpoint you already have. The agent enters its **SIP username**, **SIP password** and a
**Caller ID** in E.164 format (`+91XXXXXXXXXX`). The SIP password stays in the browser; the backend
only receives the username and caller ID.

Before using SIP direct, point the endpoint and the number at an application whose answer URL is
your backend's `/answer`.

In the Vobiz Console:

1. Create an application with answer URL `https://calling.example.com/answer` (POST) and hangup URL
   `https://calling.example.com/hangup` (POST).
2. Open the SIP endpoint and select that application.
3. For inbound calls, open the phone number and select the same application.

With the API (`X-Auth-ID` / `X-Auth-Token` headers):

```bash
# 1. Create the application — note the app_id in the response
curl -X POST https://api.vobiz.ai/api/v1/Account/MA_XXXXXXXX/Application/ \
  -H "X-Auth-ID: MA_XXXXXXXX" -H "X-Auth-Token: YOUR_AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"app_name":"Vobiz-Zoho-PhoneBridge","answer_url":"https://calling.example.com/answer","answer_method":"POST","hangup_url":"https://calling.example.com/hangup","hangup_method":"POST"}'

# 2. Attach the endpoint to it
curl -X POST https://api.vobiz.ai/api/v1/Account/MA_XXXXXXXX/Endpoint/YOUR_ENDPOINT_ID/ \
  -H "X-Auth-ID: MA_XXXXXXXX" -H "X-Auth-Token: YOUR_AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"application": YOUR_APP_ID}'      # the numeric app_id, unquoted

# 3. For inbound, attach the number (+91XXXXXXXXXX, with the + encoded as %2B)
curl -X POST "https://api.vobiz.ai/api/v1/Account/MA_XXXXXXXX/numbers/%2B91XXXXXXXXXX/application" \
  -H "X-Auth-ID: MA_XXXXXXXX" -H "X-Auth-Token: YOUR_AUTH_TOKEN" -H "Content-Type: application/json" \
  -d '{"application_id":"YOUR_APP_ID"}'
```

Not available in SIP direct, because the backend has no account credentials:

- the caller ID dropdown (the caller ID you type is used; Vobiz refuses a number your account does not own),
- **Enable inbound calls**,
- recording links in the Zoho call log,
- billed duration from Vobiz (the duration is measured by the backend instead),
- webhook signature checks: with no Auth Token, the backend cannot verify that a webhook for a
  SIP-direct agent came from Vobiz, so it accepts those unverified (see
  [Security and privacy](#security-and-privacy)). If an admin also connects the account the
  endpoint belongs to, its webhooks are checked like any other.

Inbound calls to the caller ID number ring that SIP-direct agent.

## Using it

### Outbound calls

Click a phone number anywhere Zoho offers click-to-call. Zoho sends the number to your backend,
the agent's softphone dials it, and Zoho's call bar follows the call. Agents can also type a number
in **Number to call** in the softphone and click **Call**; those calls are logged in Zoho too,
against the agent's Zoho user (an agent not mapped to a Zoho user is not logged).

If the agent has no softphone tab open, or has not signed in to Vobiz there, no call is placed and
Zoho is told the call failed with `AGENT_OFFLINE`.

### More than one tab

An agent can open the softphone in a second tab or browser. Signing in there while another tab is
open joins that tab's session: the SIP password is not changed, so the first tab stays registered,
and the new tab says so. Zoho click-to-dial goes to one tab only, the one opened (signed in) most
recently; the other tabs show where the call went. Closing that tab sends the next click to the
remaining one. Calls typed by hand work from any tab. With no tab open, signing in sets a new
password as usual.

### Inbound calls

A call to a number that rings this integration rings the softphone of every agent signed in to
the Vobiz account that owns the number. The softphone shows **Incoming call** with **Accept** and
**Decline**; **Enter** accepts and **Escape** declines. If nobody answers in 20 seconds, the caller
hears a voicemail prompt and can leave a message of up to 2 minutes. If no agent of that account is
signed in, the caller hears that no one is available, and the call ends.

### Call logging

Every Zoho-originated outbound call and every inbound call to a signed-in account is logged in Zoho
through PhoneBridge:

- direction (dialled or received), from and to numbers,
- start time and duration (billed duration from Vobiz when available),
- the Zoho user: for outbound, the user who clicked (or the agent's own Zoho user for a typed number); for inbound, the agent who answered,
- the recording link, when there is one.

For an inbound call, the ringing pop-up goes to the first ringing agent mapped to a connected Zoho
organization. When an agent answers, the log moves to that agent: the backend learns who answered
from Vobiz's Dial callback (`DialBLegTo`), or else from the softphone that accepted the call. An
inbound call nobody answers is logged as missed against that first mapped agent.

An unanswered call is logged with duration 0. Set `ZOHO_PB_SEND_MISSED_STATE=true` to log it as a
missed call instead. The log is written when the recording is ready, or 90 seconds after the call
ends if no recording arrives (`ZOHO_PB_RECORDING_GRACE_MS`).

### Recordings

Outbound calls are recorded (MP3) unless `OUTBOUND_RECORD=false`. Inbound calls are recorded when
`INBOUND_RECORD=true`.
Voicemail messages are always recorded. The call log links to a signed recording URL on your
backend that expires after 30 days by default (`RECORDING_URL_TTL_DAYS`). When Zoho opens it, your
backend fetches the audio from Vobiz and streams it back.

## Configuration reference

Set these in `backend/.env` or in your host's environment.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PUBLIC_BASE_URL` | Yes | none | Public HTTPS URL of this backend, no trailing slash. Zoho and Vobiz call back here, and it becomes the answer URL of the Vobiz application. |
| `PORT` | No | `8092` | Port the backend listens on. |
| `APP_SECRET` | Yes | none | At least 32 random characters. Signs agent sessions, agent sign-in links, click-to-dial URLs, OAuth state and recording links. The backend does not start without it. |
| `TOKEN_ENCRYPTION_KEY` | Yes | none | 32 bytes, as 64 hex characters or base64. Encrypts stored Zoho tokens and connected Vobiz accounts' Auth Tokens. The backend does not start without it. If you lose it, every Zoho organization and every Vobiz account must be connected again. |
| `ADMIN_TOKEN` | Yes | none | Long random string for the admin routes. Without it, admin routes are disabled. |
| `ZOHO_PB_CLIENT_ID` | Yes | none | Client ID of the PhoneBridge OAuth client for the Vobiz Telephony listing. |
| `ZOHO_PB_CLIENT_SECRET` | Yes | none | Client secret of that client. |
| `ZOHO_PB_REDIRECT_URI` | Yes | none | `<PUBLIC_BASE_URL>/oauth/zoho/callback` (or `/zoho/phonebridge/callback`). Must match a redirect URI registered on the client exactly. |
| `DATA_DIR` | Recommended | the `backend/` folder | Where connected organizations (`zoho-orgs.json`), connected Vobiz accounts (`vobiz-accounts.json`), agent endpoint IDs (`vobiz-endpoints.json`) and, by default, `agents.json` are kept. Use a persistent disk. |
| `AGENTS_FILE` | No | `DATA_DIR/agents.json` | Explicit path to `agents.json`. |
| `ALLOWED_ORIGINS` | No | empty | Comma-separated browser origins allowed to call the backend cross-origin. The bundled softphone needs none. |
| `REQUIRE_VOBIZ_SIGNATURE` | No | on | Vobiz webhooks must carry a valid signature (`X-Vobiz-Signature-V3`, `-V2`, `-MA-V3` or `-MA-V2`) or they are refused. `false` accepts unsigned webhooks with a warning: use it only to investigate a signature mismatch, never in production. |
| `ALLOW_AGENT_AUTH_TOKEN` | No | off | `true` lets agents sign in by typing the account's Auth Token, the old way. Use it only while moving an existing deployment over. |
| `OUTBOUND_RECORD` | No | on | `false` stops recording outbound calls. The call log then has no recording link. |
| `INBOUND_RECORD` | No | off | `true` records inbound calls. |
| `ZOHO_PB_SEND_MISSED_STATE` | No | off | `true` logs unanswered calls as missed instead of ended with duration 0. |
| `ZOHO_PB_RECORDING_GRACE_MS` | No | `90000` | How long after a call ends to wait for its recording before logging the call without one. |
| `RECORDING_URL_TTL_DAYS` | No | `30` | How long recording links in Zoho keep working. |
| `RECORDING_URL_SECRET` | No | derived from `APP_SECRET` | Separate key for signing recording links. |
| `ZOHO_PB_DEBUG` | No | off | `true` enables an admin-only PhoneBridge diagnostics route. Leave it off in production. |

No Vobiz Auth ID, Auth Token, SIP login or phone number goes in configuration. An admin connects
each Vobiz account at `/admin/vobiz-account`, and agents sign in from the softphone.

## Deploying to production

- **HTTPS only.** Serve `PUBLIC_BASE_URL` over HTTPS. If TLS ends at a proxy, make sure the proxy sends `X-Forwarded-Proto: https` so session cookies are marked `Secure`.
- **Sharing a host with other services.** The backend can sit under a path prefix, for example `https://integrations.example.com/zoho`, with your proxy stripping `/zoho` before forwarding. Set `PUBLIC_BASE_URL` to the full prefixed URL. Session cookies are then scoped to `/zoho`, so other services on the same host never see them. The softphone and sign-in pages build their URLs from their own location. The OAuth redirect URI is whatever is registered on the Zoho client: if that is `<host>/oauth/zoho/callback` at the root, route that one path to this backend unchanged.
- **Run exactly one instance.** Calls in progress and agent sessions live in the process's memory. Two instances behind a load balancer will lose calls.
- **Keep `DATA_DIR` on a persistent disk.** Connected Zoho organizations, connected Vobiz accounts and agent endpoint IDs live there. On an ephemeral filesystem, every restart means connecting each organization and account again.
- **Keep secrets in your host's secret manager.** `APP_SECRET`, `TOKEN_ENCRYPTION_KEY`, `ADMIN_TOKEN` and the Zoho client secret. Rotating `APP_SECRET` signs out every agent, invalidates all agent sign-in links, click-to-dial registrations and (unless `RECORDING_URL_SECRET` is set) recording links. Re-run register after rotating it.
- **Webhook signatures are checked and required by default.** Every webhook needs a valid Vobiz signature for the account it belongs to. If real calls are refused and the log says `signature missing or wrong — refused`, check that `PUBLIC_BASE_URL` is exactly the address Vobiz calls, path prefix included.
- **Rate-limit** `/zoho/phonebridge/clicktodial`, `/agent-session`, `/agent/vobiz-session` and `/admin/vobiz-account` at your proxy.
- **Plan restarts.** After a restart, agents must reload the softphone and sign in again. Connected Vobiz accounts are kept, so their webhooks and recording links keep working in the meantime.
- **Nothing to package for Zoho.** There is no Zoho extension to upload. Installing Vobiz Telephony from Zoho Marketplace and running connect and register is the whole Zoho side.
- **Disconnecting an organization.** `POST /zoho/phonebridge/disconnect` with `{"orgId":"…"}` (admin) removes click-to-dial, revokes the Zoho refresh token and deletes the stored organization.
- **Status.** `GET /zoho/phonebridge/status` (admin) shows configuration, connected organizations, connected and signed-in Vobiz accounts (IDs and counts only) and calls in progress.
- **Disconnecting a Vobiz account.** `POST /admin/vobiz-account/disconnect` with `{"authId":"MA_XXXXXXXX"}` (admin) deletes its stored token and signs its agents out.

## Security and privacy

- **Your Auth Token never reaches a browser.** An admin types it once at `/admin/vobiz-account`. It is checked with Vobiz and stored encrypted (AES-256-GCM with `TOKEN_ENCRYPTION_KEY`, bound to the Auth ID) in `DATA_DIR/vobiz-accounts.json`. It is never sent to a browser, returned by any route or written to logs. Agents sign in without it.
- **SIP passwords are not stored on disk.** A sign-in sets a new random password and hands it to that browser. The backend keeps it in memory only while that agent's Vobiz session lasts, so a second tab of the same agent can join it; signing out or a restart forgets it. In SIP direct mode the password never reaches the backend.
- **What is on disk.** In `DATA_DIR`: `zoho-orgs.json` (Zoho tokens encrypted with AES-256-GCM, plus datacentre and agent mapping), `vobiz-accounts.json` (connected accounts' Auth Tokens, encrypted the same way) and `vobiz-endpoints.json` (endpoint ID and SIP username per agent, no passwords). All are readable only by the backend's user.
- **What the browser receives.** Its own agent session cookie (HttpOnly, SameSite=Strict, 12 hours), its own SIP login, and the list of the account's numbers. Never an Auth Token, a Zoho token or another agent's data.
- **Every route needs a credential.** Admin routes need `ADMIN_TOKEN`. Agent routes need the agent session. Click-to-dial URLs registered with Zoho carry a signed token for their organization and agent. The Zoho sign-in callback accepts only a signed state that expires after 15 minutes. Vobiz webhooks need Vobiz's signature (below).
- **Vobiz webhooks must be signed.** Each webhook is checked against the Auth Token of the account it belongs to, and acts for that account only: a webhook signed with one customer's token can never ring, log or end another customer's calls. One without a valid signature is refused. The exception is a webhook for a SIP-direct agent, which the backend has no token to check; it is accepted only for an agent signed in SIP direct right now. Vobiz signs the URL and a random nonce, not the request body.
- **The softphone shows caller data as text.** Caller names and numbers are never inserted into the page as HTML, the backend passes on only a plain caller name or a phone number, and click-to-dial accepts only a phone number. The page is served with a strict `Content-Security-Policy` that allows only its own scripts, pinned by hash, and network access only to this backend and the Vobiz registrar.
- **A malformed request cannot stop the backend.** Every request runs inside an error guard, and nothing that parses a request can throw outside it. A bad request gets a `400` or `500`; everyone else's calls carry on.
- **Recording links are signed, scoped and expiring.** A link names one Vobiz account and one recording, and cannot be altered to fetch anything else. It carries no Vobiz credentials. Audio is only fetched from Vobiz.
- **CORS is an allowlist.** Empty by default, never `*`.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Backend exits at start with `APP_SECRET must be set…` or `TOKEN_ENCRYPTION_KEY…` | The secret is missing or the wrong length. | Generate it with the commands in [Quick start](#quick-start). |
| `/admin/...` returns `ADMIN_TOKEN is not set on this backend` | `ADMIN_TOKEN` is empty. | Set it and restart. |
| Connect returns `Zoho PhoneBridge is not configured` | A `ZOHO_PB_*` variable is missing. | Set `ZOHO_PB_CLIENT_ID`, `ZOHO_PB_CLIENT_SECRET` and `ZOHO_PB_REDIRECT_URI`. |
| Zoho shows an invalid redirect URI error | `ZOHO_PB_REDIRECT_URI` is not registered on the client exactly. | Use `<PUBLIC_BASE_URL>/oauth/zoho/callback` and have it registered on the client character for character. |
| Zoho shows an invalid client error at consent | The client is registered in one Zoho datacentre only. | Open `/zoho/phonebridge/connect?dc=in` (or `us`, `eu`, `au`… your datacentre). |
| Approved in Zoho, but the redirect landed on a different host | The registered redirect URI is not served by this backend. | Open `/zoho/phonebridge/complete`, paste the full URL Zoho redirected to within a minute. Then fix the redirect URI. |
| Callback says `missing, forged or expired 'state'` | More than 15 minutes passed, or the flow was started elsewhere. | Start again from `/zoho/phonebridge/connect`. |
| Register fails at step `integrate` | Vobiz Telephony is not installed for this Zoho organization. | Install it in Zoho **Marketplace → Telephony**, then register again. |
| Register says `no agent in agents.json matches a Zoho user` | Emails or `zohoUser` IDs do not match. | Use the `zohoUsers` list in the response to fix `agents.json`, then register again. |
| Clicking a number in Zoho fails with `AGENT_OFFLINE` | The agent's softphone tab is closed, or they have not signed in to Vobiz there, or the backend restarted. | Open the softphone, sign in to Vobiz, wait for **Ready**, and keep the tab open. |
| Clicking a number fails with `NO_CALLER_ID` | The Vobiz account has no active, voice-enabled number. | Add a number to the account and sign in again. |
| Clicking a number fails with `INVALID_NUMBER` | The Zoho field holds something that is not a phone number (letters, for example). | Fix the number on the Zoho record. Spaces, dashes, dots and brackets are fine. |
| Softphone shows **Not signed in** | The 12-hour agent session expired, or the link was never opened in this browser. | Open your sign-in link again. If it is rejected, ask the admin for a fresh one. |
| Softphone says **No Vobiz account is connected for you yet** | No account is connected, or several are and this agent has no `vobizAccount` in `agents.json`. | Connect the account at `/admin/vobiz-account`, or add `"vobizAccount": "MA_XXXXXXXX"` to the agent. |
| **Agents do not sign in with the account's Auth Token here** | An agent sent the account's Auth Token; that is refused by default. | Connect the account as admin. Only during a migration, set `ALLOW_AGENT_AUTH_TOKEN=true`. |
| **Vobiz did not accept those credentials** (softphone or admin connect) | Wrong Auth ID or Auth Token, or the token was changed in the Vobiz Console. | Copy both again from Vobiz Console → **API credentials** and connect the account again. |
| Calls fail and the log says `signature missing or wrong — refused` | `PUBLIC_BASE_URL` is not exactly the address Vobiz calls, or the account the webhook belongs to is not connected and no agent of it is signed in. | Set `PUBLIC_BASE_URL` to the exact public URL, path prefix included, and connect the account. `REQUIRE_VOBIZ_SIGNATURE=false` accepts unsigned webhooks while you investigate. Never leave it in production. |
| **Registration failed** in the softphone | The SIP password changed: the agent signed in again after closing every tab, or the backend restarted. | Reload the tab and sign in again. A second tab opened while one is still open does not change the password. |
| Clicking a number in Zoho dials in the wrong tab | Click-to-dial goes to the agent's most recently opened tab. | Use that tab, or close it so clicks go to the other one. |
| Softphone says **Microphone blocked — calls will have no audio** | The browser refused the microphone at sign-in. | Allow the microphone for the backend's URL (the icon left of the address bar), then reload. |
| Calls fail with **This line has no caller ID configured** | No caller ID is set for the agent. | Choose a caller ID in the dropdown, or sign in with an account that has a number. |
| Inbound calls hear "no one is available" | No agent of the account that owns the number is signed in, or the backend restarted. | Have an agent sign in. Check the number shows **· inbound on**. |
| Softphone says **Vobiz never rang this browser** | The call was routed to the agent but the browser was not reachable. | Reload the softphone and sign in again. |
| No audio, or the call drops when it connects | Microphone permission is blocked. | Allow the microphone for the backend's URL permanently, reload, and call again. |
| An inbound call is logged against the wrong agent | Neither Vobiz nor the softphone reported who answered (for example the tab lost its connection to the backend). | Check the backend log for `answered by`. Keep the softphone tab connected. |
| Recording link in Zoho says the account must sign in again (503) | The backend restarted, the account is not connected, and no agent of it has signed in since. | Connect the account as admin, so its links survive restarts. Or have any agent of that account sign in. |
| Recording link returns 410 | The link expired. | Increase `RECORDING_URL_TTL_DAYS` for future calls. |

The backend log names every step of a call (`[zoho-pb]`, `[vobiz]`, `[backend]` lines). Start there.

## Limitations

- **Early access.** There is no Vobiz-hosted backend yet. You run it yourself.
- **One backend instance.** State for calls in progress and agent sessions is held in memory.
- **Sign in again after a restart.** SIP passwords live only in memory, so after the backend restarts every agent must reload the softphone and sign in again. A connected account's token is kept, so its webhooks are still verified and its recording links still play. An account whose agents typed its token (`ALLOW_AGENT_AUTH_TOKEN`) is unknown until one of them signs in again. A call in progress during a restart is not logged.
- **Sign in again after a page reload.** The SIP password lives only in the page, so reloading the softphone signs in to Vobiz again.
- **The softphone tab must stay open.** Click-to-dial fails with `AGENT_OFFLINE` without it.
- **Click-to-dial reaches one tab.** With several tabs open, Zoho clicks go to the most recently opened one.
- **Inbound rings everyone on the account.** Every signed-in agent of the Vobiz account rings at once, and there is no per-number assignment. Zoho's ringing pop-up appears for the first ringing agent mapped to a Zoho organization; the call log goes to the agent who answered.
- **SIP direct** has no caller ID list, no **Enable inbound calls** and no recording links in Zoho. Its webhooks cannot be verified unless an admin also connects the account its endpoint belongs to.
- **Agent sessions last 12 hours** and cannot be revoked one at a time; rotating `APP_SECRET` ends them all.
- **No transfers and no ringing groups.**

## Development

```bash
cd backend
npm test        # self-contained: no network, no real accounts
```

There are no npm dependencies and no build step. The JsSIP library ships in `backend/public/`.

```
backend/
  server.js               HTTP routes: Zoho, Vobiz webhooks, admin, agent
  zoho-phonebridge.js     PhoneBridge API, OAuth, datacentre lookup, call tracking
  vobiz-accounts.js       Vobiz sign-in: application, endpoint, numbers, inbound attach
  auth.js                 admin token, agent sessions, signed links and URLs, CORS
  token-store.js          encrypted per-organization Zoho token store
  agents.js               agents.json loading and Zoho user matching
  public/agent-phone.html the agent softphone
  test-zoho-phonebridge.js
```

Calls this backend makes to Zoho, all under `{api_domain}/phonebridge/v3/` with the
`Zoho-oauthtoken` header: `integrate`, `users`, `clicktodial` (POST and DELETE), `callnotify`
and `clicktodialerror`. See Zoho's [PhoneBridge V3 reference](https://www.zoho.com/phonebridge/developer/v3/).

## Support

- Integration guide: https://www.vobiz.ai/docs/integrations/zoho
- Vobiz documentation: https://www.vobiz.ai/docs
- Help: [support@vobiz.ai](mailto:support@vobiz.ai)
- Security reports: see [SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE)
