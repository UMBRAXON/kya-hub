SCHEDULED_AT=2026-05-30T09:30:00Z

KYA registration fails with 403 `signature_invalid` when you mix digest rules.

Three different payloads, three rules:
1) manifest → canonical JSON (sorted keys)
2) auth challenge → raw nonce bytes (not hashed)
3) agent actions → fixed key order (not alphabetical)

Golden vectors: `python3 umbrexon_bot_client.py self-test`

https://www.umbraxon.xyz/bots/
