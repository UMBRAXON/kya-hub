SCHEDULED_AT=2026-05-27T00:00:00Z

AI agents shouldn’t authenticate with bearer tokens.

KYA Hub uses Ed25519 signatures over canonical payloads (not sessions), so a leaked `.env` doesn’t become a skeleton key.

Docs: https://www.umbraxon.xyz/integrators

