# Google Search Console — manuálny checklist (bez API)

API (service account + Search Console property) je možné doplniť neskôr. Zatiaľ stačí UI raz týždenne.

## Týždenné (5 min)

1. [search.google.com/search-console](https://search.google.com/search-console) → property **`https://www.umbraxon.xyz`**
2. **Indexovanie → Strany** — počkaj, kým zmizne „údaje sa spracovávajú“ (24–72 h po novej property).
3. **Sitemaps** — stav `https://www.umbraxon.xyz/sitemap.xml` musí byť **Úspech**.
4. **Kontrola URL** — otestuj:
   - `https://www.umbraxon.xyz/`
   - `https://www.umbraxon.xyz/integrators`
   - `https://www.umbraxon.xyz/about`
5. Ak „URL nie je v indexe“ → **Požiadať o indexovanie** (max pár URL/deň).

## Čo zapisovať do poznámky

| Dátum | Indexované strany | Impresie (7d) | Poznámka |
|-------|-------------------|---------------|----------|
| | | | |

## Časté príčiny prázdneho indexu

- Property je **iná doména** (preklep: `ambroze.xyz` vs `umbraxon.xyz`).
- Sitemap neodoslaná.
- Stránka nová (< 2 týždne) — normálne oneskorenie.
- Technicky OK: `robots.txt` Allow, meta `index,follow` (overené na portáli).

## Cloudflare (návštevnosť, nie index)

**Analytics → Web Analytics** — requesty a LCP; to nie je GSC, ale dopĺňa obraz.
