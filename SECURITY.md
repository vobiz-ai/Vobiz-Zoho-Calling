# Security policy

## Reporting a vulnerability

Email **security@vobiz.ai** (or **support@vobiz.ai**). Please do not open a
public issue for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with
it. We will acknowledge your report and keep you updated.

## What this software protects, and what it does not

### What is handled

**Every route that does something needs a credential.** Admin routes (connect,
register, disconnect, status) need `ADMIN_TOKEN`. An agent's softphone gets an
HttpOnly, SameSite=Strict session cookie in exchange for that agent's key; only
then can it sign in to Vobiz, and only for itself. Click-to-dial URIs registered with
Zoho carry an HMAC token for their org and agent; a request without it places
no call. The OAuth callback accepts only a signed, expiring `state`.

**Zoho tokens are encrypted at rest.** AES-256-GCM with `TOKEN_ENCRYPTION_KEY`,
bound to the org id, in a 0600 file under `DATA_DIR`. Listings never return a
token. Disconnecting an org revokes its refresh token at Zoho.

**No Vobiz credential is configured on the server.** Each agent types their
Vobiz Auth ID and Auth Token into the softphone. The token is checked against
Vobiz, kept in server memory keyed by Auth ID, and never returned in a
response, logged or written to disk. The browser holds only its own SIP
password, handed out once per sign-in and rotated on every sign-in; on disk
there is only `{endpointId, username}` per agent (0600). In SIP-direct mode the
SIP password never reaches the backend at all.

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

**Vobiz webhook signatures are verify-and-warn by default.** Each webhook is
checked with the token of the account it belongs to (by SIP username,
`ParentAuthID`, dialled DID or our own callback URL); a webhook for an account
with no token in memory — after a restart, or SIP-direct — cannot be verified
and counts as unsigned. Set
`REQUIRE_VOBIZ_SIGNATURE=true` once your logs show `signature ok` on a real
call. Until then, anyone who can reach the webhook routes can send fake call
events (they cannot place calls or read secrets through them).

**Agent sessions cannot be revoked one at a time.** They expire after 12
hours; rotating `APP_SECRET` ends all of them and invalidates every agent link,
every click-to-dial registration (re-run register) and, unless
`RECORDING_URL_SECRET` is set, every recording link already in Zoho.

**Deployment secrets live in environment variables** (`APP_SECRET`,
`TOKEN_ENCRYPTION_KEY`, `ADMIN_TOKEN`, the Zoho PhoneBridge client). Use your host's secret manager.

**No rate limiting.** Put the backend behind a proxy that rate-limits
`/zoho/phonebridge/clicktodial`, `/agent-session` and `/agent/vobiz-session`.
