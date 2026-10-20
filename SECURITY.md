# Security policy

## Reporting a vulnerability

Email **security@vobiz.ai** (or **support@vobiz.ai**). Please do not open a
public issue for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with
it. We will acknowledge your report and keep you updated.

## What this software protects, and what it does not

### What is handled

**Every route that does something needs a credential.** Admin routes (connect,
register, disconnect, status, Vobiz accounts) need `ADMIN_TOKEN`. An agent's
softphone gets an HttpOnly, SameSite=Strict session cookie in exchange for that
agent's key; only then can it sign in to Vobiz, and only for itself.
Click-to-dial URIs registered with Zoho carry an HMAC token for their org and
agent; a request without it places no call. The OAuth callback accepts only a
signed, expiring `state`. Vobiz webhooks need Vobiz's signature (below).

**Zoho tokens are encrypted at rest.** AES-256-GCM with `TOKEN_ENCRYPTION_KEY`,
bound to the org id, in a 0600 file under `DATA_DIR`. Listings never return a
token. Disconnecting an org revokes its refresh token at Zoho.

**Agents never handle the Vobiz account's Auth Token.** An admin connects each
Vobiz account once; its Auth Token is checked against Vobiz and sealed with
`TOKEN_ENCRYPTION_KEY` (AES-256-GCM, bound to the Auth ID) in
`DATA_DIR/vobiz-accounts.json`, 0600. It is never returned in a response or
logged. Agents sign in from the softphone without it, on the account assigned to
them (or the only connected one); they cannot pick another. A softphone that
sends an Auth Token is refused unless `ALLOW_AGENT_AUTH_TOKEN=true`, which exists
only for migrating an older deployment. The browser holds only its own SIP
password, handed out on sign-in; on disk there is only `{endpointId, username}`
per agent (0600). In SIP-direct mode the SIP password never reaches the backend
at all.

**Vobiz webhooks must be signed.** Every webhook is checked against the Auth
Token of the account it belongs to (`X-Vobiz-Signature-V3`, `-V2`, or the
parent-account `-MA-V3` / `-MA-V2`), and it then acts for that account only, so
a webhook signed by one customer can never reach another customer's agents,
calls or Zoho log. One that does not verify is refused.
`REQUIRE_VOBIZ_SIGNATURE=false` turns this back into verify-and-warn, for
debugging only.

**No request can stop the process.** Every route runs inside an error guard, and
nothing that parses a request (paths, cookies) throws outside one. A malformed
request costs that request a `400` or `500`, never every agent's session and
every call in progress.

**The softphone treats caller data as text.** Caller names, numbers and
click-to-dial numbers are never inserted into the page as HTML. The backend
passes on only a plain caller name or a phone number, and refuses a
click-to-dial "number" that is not one. The page is served with a strict
`Content-Security-Policy`: scripts from its own origin and its own inline
script (pinned by SHA-256) only, network access to this backend and the Vobiz
registrar only.

**Recording links carry no credentials and are scoped to one account.** The
Auth ID is inside the HMAC, so a link cannot be pointed at another account.
They are HMAC-signed and expire
(30 days by default, `RECORDING_URL_TTL_DAYS`). The audio is fetched
server-side, only from a vobiz.ai host, by recording id — there is no route
that fetches a caller-supplied URL.

**CORS is an allowlist** (`ALLOWED_ORIGINS`), empty by default. Never `*`.

**Static files come from a fixed list.** No request path reaches the
filesystem.

### What is not handled

**SIP-direct webhooks cannot be verified.** The backend holds no Auth Token for
an endpoint an agent signs in with directly, so a webhook for a SIP-direct agent
signed in right now is accepted unverified. Anyone who knows that agent's number
could send it fake call events. Connecting the endpoint's account as admin makes
its webhooks checked like any other.

**Vobiz's signature covers the URL and a nonce, not the body.** A signed request
someone captured in transit could be replayed with a different body. That takes
access to real traffic. The backend does not track nonces.

**The softphone's page shares an origin with anything else on the same host.**
Under a path prefix on a shared host (see the README), other apps there are
same-origin with this one. Prefer a host of its own.

**Agent sessions cannot be revoked one at a time.** They expire after 12
hours; rotating `APP_SECRET` ends all of them and invalidates every agent link,
every click-to-dial registration (re-run register) and, unless
`RECORDING_URL_SECRET` is set, every recording link already in Zoho.

**Deployment secrets live in environment variables** (`APP_SECRET`,
`TOKEN_ENCRYPTION_KEY`, `ADMIN_TOKEN`, the Zoho PhoneBridge client). Use your host's secret manager.
`TOKEN_ENCRYPTION_KEY` now guards the connected Vobiz accounts' Auth Tokens too.

**No rate limiting.** Put the backend behind a proxy that rate-limits
`/zoho/phonebridge/clicktodial`, `/agent-session`, `/agent/vobiz-session` and
`/admin/vobiz-account`.
