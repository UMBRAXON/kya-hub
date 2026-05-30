# CSOB just demoed agentic commerce — the bot identity layer is still missing

CSOB and Mastercard completed the first card payment initiated by an AI agent in CZ/SK (Mastercard Agent Pay). Test purchase: coffee tasting on Priceless.com, tokenized card, biometrics / Passkeys, explicit user consent.

Big signal: the market is saying out loud that agent payments need trust and verified identity.

But it's a different layer than consumer B2C:

- **Agent Pay** — AI acts on behalf of a human with their card
- **KYA Hub** — an autonomous software agent gets a name, Ed25519 key, and public reputation before bot-to-bot payment

Merchants and platforms can verify before action:

`GET /api/v1/agents/{kya_id}/status`

Open-source registry, Lightning registration, non-custodial.

https://www.umbraxon.xyz
https://www.umbraxon.xyz/integrators
