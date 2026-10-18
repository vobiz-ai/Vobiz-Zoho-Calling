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
HttpOnly, SameSite=Strict session cookie in exchange for that agent's key, and
can then read only its own SIP credentials. Click-to-dial URIs registered with
Zoho carry an HMAC token for their org and agent; a request without it places
no call. The OAuth callback accepts only a signed, expiring `state`.

**Zoho tokens are encrypted at rest.** AES-256-GCM with `TOKEN_ENCRYPTION_KEY`,
bound to the org id, in a 0600 file under `DATA_DIR`. Listings never return a
token. Disconnecting an org revokes its refresh token at Zoho.

**The browser never holds the Vobiz Auth Token.** It stays on the server. The
browser holds only its own agent's SIP endpoint password, after signing in.

**Recording links carry no credentials.** They are HMAC-signed and expire
(30 days by default, `RECORDING_URL_TTL_DAYS`). The audio is fetched
server-side, only from a vobiz.ai host, by recording id — there is no route
that fetches a caller-supplied URL.

**CORS is an allowlist** (`ALLOWED_ORIGINS`), empty by default. Never `*`.

**Static files come from a fixed list.** No request path reaches the
filesystem.

### What is not handled

**Vobiz webhook signatures are verify-and-warn by default.** Set
`REQUIRE_VOBIZ_SIGNATURE=true` once your logs show `signature ok` on a real
call. Until then, anyone who can reach the webhook routes can send fake call
events (they cannot place calls or read secrets through them).

**Agent sessions cannot be revoked one at a time.** They expire after 12
hours; rotating `APP_SECRET` ends all of them and invalidates every agent link
and click-to-dial registration (re-run register).

**Secrets live in environment variables.** Use your host's secret manager.

**No rate limiting.** Put the backend behind a proxy that rate-limits
`/zoho/phonebridge/clicktodial` and `/agent-session`.
