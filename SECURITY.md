# Security policy

## Reporting a vulnerability

Email **security@vobiz.ai** (or **support@vobiz.ai**). Please do not open a
public issue for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with
it. We will acknowledge your report and keep you updated.

## What this software protects, and what it does not

Be clear-eyed about this before deploying. The list below is honest rather than
reassuring.

### What is handled

**The browser never holds your Vobiz Auth Token.** It is posted once at sign-in
and exchanged for an opaque session token.

**Recording links carry no credentials.** They are HMAC-signed with a short
expiry, and the audio is fetched server-side. A link that leaks grants nothing
but that one recording, and only until it expires.

**Recording playback takes no caller-supplied URL.** An earlier generation of
this pattern accepted a `url` parameter and fetched it with the account's Vobiz
credentials attached — a credential-exfiltration primitive any web page could
drive. Never reintroduce one.

**CORS is an allowlist**, not `*`.

### What is not handled

**The backend binds to a single Vobiz account.** Every agent who signs in shares
one SIP endpoint. This is fine for a pilot and wrong for a real deployment.

**There is no per-agent identity.** The agent id selects a label, not an
identity, and nothing stops a signed-in user from asserting another.

**Secrets live in `.env`.** There is no secret manager, no encryption at rest,
and no rotation. Treat the host as sensitive.

**A quick tunnel is not production infrastructure.** Its hostname changes on
every restart and it is publicly reachable while it is up.

Deploying this as-is for real customer traffic needs, at minimum: an endpoint
per agent, an identity store, a stable hostname, and secrets held somewhere
better than a file.
