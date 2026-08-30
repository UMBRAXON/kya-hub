# jasnelabs.eu — Google indexácia + SEO (INTERNÉ)

**Dátum:** 2026-08-26  
**Pravidlo:** bez zásahu do `index.html` / dizajnu. Len `robots.txt` + `sitemap.xml` (+ GSC).

## Live

| Položka | URL |
|---------|-----|
| Canonical | `https://www.jasnelabs.eu/` |
| Apex | `jasnelabs.eu` → 301 www |
| Sitemap | `https://www.jasnelabs.eu/sitemap.xml` |
| Robots | `https://www.jasnelabs.eu/robots.txt` |
| Súbory | `/root/kya-hub/jasnelabs/dist/` (mount do `jasnelabs-proxy`) |

## Čo už web má (bez zmeny HTML)

- `<title>`, meta description, canonical, OG title/description/url
- hreflang sk + en (`?lang=en`)
- theme-color

## Čo urobiť v GSC (owner)

1. [Search Console](https://search.google.com/search-console) → property **URL prefix** `https://www.jasnelabs.eu`
2. Overenie DNS TXT (Cloudflare) — bez zmeny webu
3. Sitemaps → odošli podľa typu property (pozri nižšie)
4. Kontrola URL → `https://www.jasnelabs.eu/` → Požiadať o indexáciu  
   (voliteľne aj `https://www.jasnelabs.eu/?lang=en`)

## SEO neskôr (až dovolíš zmenu HTML)

- Silnejší title: „jasnelabs — NaKus, Klubo, UMBRAXON“ (nie len doména)
- `og:image` 1200×630
- JSON-LD Organization
- Oddelené `/en` cesty namiesto `?lang=en` (lepšie pre indexáciu)

## Checklist

- [x] `robots.txt` + `sitemap.xml` na www (zjednodušená mapa: len homepage)
- [x] nginx `location = /sitemap.xml` + `/robots.txt` (bez SPA fallback)
- [ ] GSC property overená (`https://www.jasnelabs.eu` — **www**)
- [ ] Sitemap v GSC (Domain property často „Nie je možné načítať“ aj pri OK serveri — **nie je blocker**)
- [x] Request indexing homepage — **prešlo** (2026-08-29)
- [ ] Po týždni: `site:www.jasnelabs.eu`

### Sitemap vs indexácia (2026-08-29)

**Homepage indexácia prešla** → cieľ splnený pre 1-stránkový hub.  
GSC **Sitemaps** môže na Domain property `jasnelabs.eu` stále ukazovať „Nie je možné načítať“ — server vracia 200, Bot Fight Mode Off; ide o GSC/Domain property quirk, nie o chýbajúci obsah.

**Stačí:** `robots.txt` riadok `Sitemap:` + URL Inspection na `/` (hotové).  
**Voliteľne:** druhá property **URL prefix** `https://www.jasnelabs.eu` → tam `sitemap.xml` — ak chceš zelený riadok v Sitemaps kvôli estetike.

### Ak GSC hlási „Nie je možné načítať“

**Overené 2026-08-29:** origin + Cloudflare vracajú **HTTP 200**, `Content-Type: application/xml`, validný XML (Googlebot UA tiež 200). GSC riadok z **26. 8.** je **starý neúspech** — server teraz OK.

1. Over v prehliadači: https://www.jasnelabs.eu/sitemap.xml → XML, nie HTML. Rovnako https://jasnelabs.eu/sitemap.xml → **200** (nie redirect).
2. Property musí sedieť s URL v mape:
   - property **`https://www.jasnelabs.eu`** → v mape `<loc>https://www.jasnelabs.eu/</loc>` ✓
   - property **`https://jasnelabs.eu`** (bez www) → buď zmeň property na www, alebo v GSC použij domain property `jasnelabs.eu`
3. V Sitemaps: **⋮ → Odstrániť** starý riadok (zlyhanie pred opravou), počkaj 1 min, znova odošli len **`sitemap.xml`** (nie celá URL — pri URL prefix property stačí relatívna cesta).
4. Content-Type má byť `application/xml` (opravené v nginx).
5. **Cloudflare** (ak stále padá): Security → Bot Fight Mode **off** alebo „Allow verified bots“; WAF nesmie blokovať `Googlebot` na `/sitemap.xml`.
6. Počkaj 10–30 min na „Posledné načítanie“ (Google ping API je deprecated od 2023 — stačí resubmit v GSC).

### „Neplatná adresa“ pri odosielaní sitemap

GSC **Domain property** (`jasnelabs.eu` v ľavom hornom rohu, **bez** `https://`) **neprijme** relatívnu cestu `sitemap.xml`.

| Typ property v GSC | Čo vložiť do poľa |
|--------------------|-------------------|
| **Domain** `jasnelabs.eu` | **`https://www.jasnelabs.eu/sitemap.xml`** (celá URL) |
| **URL prefix** `https://www.jasnelabs.eu` | `sitemap.xml` |

Skontroluj vľavo hore názov property — ak je len `jasnelabs.eu`, použij **plnú URL** vyššie.
