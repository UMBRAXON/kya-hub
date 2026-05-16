# KYA Hub Portal (Next.js SPA)

Future Dark Tech marketing / discovery single-page app for Umbraxon KYA Hub.

## Stack

- Next.js 15 (App Router)
- TypeScript
- Tailwind CSS v4
- shadcn/ui (Button, Input, Badge, Card)
- Geist font
- lucide-react icons

## Run locally

```bash
cd portal
npm install
npm run dev
```

Open [http://localhost:3001](http://localhost:3001) (port 3000 is often used by KYA Hub API).

Agents are loaded server-side from `GET /api/discovery/v1/agents.json` (revalidate every 60s). Set `NEXT_PUBLIC_HUB_URL` in `.env.local` if needed.

## Production build

```bash
npm run build
npm start
```

## Sections

- Fixed glassmorphism navbar
- Hero with cyan / outline CTAs
- Agent grid with search (demo data; wire to `/api/discovery/v1/agents.json` in production)
- Documentation cards linking to hub docs
- Footer

## Theming

Accent: `#00FFFF` · Background: `#111111` · See `app/globals.css` for neon hover utilities.
