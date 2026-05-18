# SEO a indexácia webu (www.umbraxon.xyz)

Technické súbory sú v **porte** (`portal/app/sitemap.ts`, `robots.ts`, Open Graph).  
Tento dokument = kroky, ktoré musí urobiť **operátor** (Google, Cloudflare, DNS).

---

## Čo už beží na serveri (po deploy portálu)

| URL | Účel |
|-----|------|
| `/sitemap.xml` | Mapa stránok pre Google |
| `/robots.txt` | Povolenie crawlu + odkaz na sitemap |
| `/opengraph-image` | Náhľad pri zdieľaní (X, LinkedIn) |
| JSON-LD na homepage | `WebSite` schema |

Env (voliteľné): `NEXT_PUBLIC_SITE_URL=https://www.umbraxon.xyz` v `portal/.env.local`.

---

## Krok 1 — Jedna canonical doména (Cloudflare / DNS)

**Cieľ:** Všetko vedie na `https://www.umbraxon.xyz`.

1. Prihlás sa do **Cloudflare** → doména `umbraxon.xyz`.
2. **DNS**
   - `www` → A/AAAA alebo CNAME na origin (ako dnes).
   - apex `@` → redirect na `www` (Cloudflare **Redirect Rules** alebo **Page Rule**):
     - `https://umbraxon.xyz/*` → `https://www.umbraxon.xyz/$1` (301).
3. **SSL/TLS** → **Full (strict)**.
4. Počkaj 5–15 min, over:
   ```bash
   curl -sI https://umbraxon.xyz/ | grep -i location
   curl -sI https://www.umbraxon.xyz/ | head -3
   ```

---

## Krok 2 — Cloudflare a robots.txt

Ak `curl https://www.umbraxon.xyz/robots.txt` ukazuje **Cloudflare Content Signals** namiesto `Sitemap: https://www...`:

1. Cloudflare dashboard → **Bots** / **Scrape Shield** / **Content Signals** (názov sa môže líšiť).
2. Vypni managed `robots.txt` pre `www.umbraxon.xyz`, **alebo**
3. Pravidlo: cesta `/robots.txt` → origin (bypass managed response).

Správny výstup by mal obsahovať aspoň:
```
User-agent: *
Allow: /
Sitemap: https://www.umbraxon.xyz/sitemap.xml
```

---

## Krok 3 — Google Search Console

1. Otvor https://search.google.com/search-console  
2. **Add property** → **URL prefix** → `https://www.umbraxon.xyz`
3. **Overenie vlastníctva** (vyber jednu metódu):

   **A) DNS (odporúčané)**  
   - Skopíruj TXT záznam z GSC (napr. `google-site-verification=...`).  
   - Cloudflare → DNS → Add record → Type **TXT**, Name `@`, Content = hodnota.  
   - Verify v GSC (môže trvať až 24 h, často minúty).

   **B) HTML súbor**  
   - Stiahni `googlexxxxx.html` z GSC.  
   - Daj do `portal/public/` a rebuild portál, **alebo**  
   - Servuj cez nginx alias na hub.

4. Po overení: **Sitemaps** → pridaj `sitemap.xml` (celá URL nie je potrebná, stačí `sitemap.xml`).
5. **URL inspection** → `https://www.umbraxon.xyz/` → **Request indexing**.
6. To isté pre `https://www.umbraxon.xyz/integrators`.

---

## Krok 4 — Bing Webmaster Tools

1. https://www.bing.com/webmasters  
2. Import site from Google Search Console **alebo** pridaj `https://www.umbraxon.xyz` a over TXT/DNS.  
3. Submit sitemap: `https://www.umbraxon.xyz/sitemap.xml`.

---

## Krok 5 — Externé odkazy (urýchľuje indexáciu)

| Kde | Čo |
|-----|-----|
| GitHub `UMBRAXON/kya-hub` README | Link na https://www.umbraxon.xyz |
| YouTube intro video | Popis + pinned comment s URL |
| Show HN / Reddit | Príspevky z marketing plánu |
| `package.json` / PyPI (neskôr) | Homepage URL |

Bez aspoň 2–3 kvalitných odkazov môže Google stránku objaviť až po týždňoch.

---

## Krok 6 — Kontrola po týždni

```bash
# Google (v prehliadači)
site:www.umbraxon.xyz

# Sitemap živý
curl -sS https://www.umbraxon.xyz/sitemap.xml | head -20

# Robots
curl -sS https://www.umbraxon.xyz/robots.txt
```

V Search Console: **Pages** → indexed vs not indexed, **Performance** → queries (po mesiaci).

---

## Deploy po zmene SEO v portáli

```bash
cd /root/kya-hub/portal && npm run build
pm2 restart kya-portal
```

---

## Čo neindexovať (zámerne)

- `/api/admin/*`, webhooky — v `robots.txt` disallow (API na rovnakej doméne).
- Testovací šum v DB — nie je na webe.

---

## Riešenie problémov

| Problém | Riešenie |
|---------|----------|
| sitemap 404 | `pm2 restart kya-portal`, over build |
| robots stále Cloudflare | Krok 2 |
| GSC „Couldn't fetch“ | Over CF/WAF, či Googlebot nie je blokovaný |
| Stránka v Google, ale nie homepage | Request indexing + odkazy z GitHub |
