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
3. Sitemaps → odošli: `sitemap.xml` (alebo `https://www.jasnelabs.eu/sitemap.xml`)
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
- [ ] Sitemap znova odoslaná po „Nie je možné načítať“ (klik ⋮ → Odstrániť, potom znova `sitemap.xml`)
- [ ] Request indexing homepage
- [ ] Po týždni: `site:www.jasnelabs.eu`

### Ak GSC hlási „Nie je možné načítať“

**Overené 2026-08-26:** server vracia 200 + valid XML. Apex `/sitemap.xml` už **nie je** 301 (GSC pri property bez www inak padá).

1. Over v prehliadači: https://www.jasnelabs.eu/sitemap.xml → XML, nie HTML. Rovnako https://jasnelabs.eu/sitemap.xml → **200** (nie redirect).
2. Property musí sedieť s URL v mape:
   - property **`https://www.jasnelabs.eu`** → v mape `<loc>https://www.jasnelabs.eu/</loc>` ✓
   - property **`https://jasnelabs.eu`** (bez www) → buď zmeň property na www, alebo v GSC použij domain property `jasnelabs.eu`
3. V Sitemaps: **⋮ → Odstrániť** starý riadok (zlyhanie pred opravou), počkaj 1 min, znova odošli len `sitemap.xml`.
4. Content-Type má byť `application/xml` (opravené v nginx).
5. Počkaj 10–30 min na „Posledné načítanie“.
