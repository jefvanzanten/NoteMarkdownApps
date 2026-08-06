# ADR 0003 — Milestone 3 accounts and Drive

## Status

Accepted for milestone 3.

## Decisions

- Use Hono with `@hono/zod-openapi`; Zod runtime schemas in `@note/api-contracts` generate OpenAPI and reject unknown metadata fields.
- Use PostgreSQL through Drizzle with every owned query scoped by internal user ID.
- Store only SHA-256 session digests in PostgreSQL and opaque session values in `HttpOnly`, `SameSite=Lax`, production-`Secure` cookies.
- Envelope-encrypt Google refresh tokens with AES-256-GCM. `TOKEN_ENCRYPTION_KEYS` is a versioned key ring and new writes use the highest version.
- Request `openid email profile` plus Google's non-sensitive `drive.file` scope. Google Picker grants user selection rather than indexing all Drive. Superseded by the amendment below.

## Amendment

The `drive.file` scope does not authorize existing children of a Picker-selected folder, so folder workspaces listed empty. The grant now requests the full `https://www.googleapis.com/auth/drive` scope, the token endpoint rejects grants missing it with `reauthorization-required`, and the client prompts affected users to reconnect.
- Return short-lived access tokens to authenticated browser memory. Markdown and images transfer directly between the browser and `www.googleapis.com`; the API exposes no content endpoint.
- Retain Drive Markdown mirrors using non-extractable per-account Web Crypto AES-GCM keys in IndexedDB. Explicit logout/disconnect removes active keys and leaves ciphertext locked.
- Synchronize global preferences with a last-updated timestamp; the newer local/server snapshot wins on first sign-in.

## Follow-up for milestone 4

ADR 0004 accepts the central encrypted document repository, per-document pending writes, priority reconciliation, and incremental Drive change discovery. Wrapped-key re-unlock, complete image mirroring, the generalized durable operation queue, and three-way conflict handling remain milestone 4 work.

See [ADR 0004 — Local-first workspace cache and priority reconciliation](0004-local-first-workspace-cache-and-priority-reconciliation.md).
