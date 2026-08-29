# jasnelabs.eu — GSC „Nie je možné načítať“ + Cloudflare

**Stav servera (2026-08-29):** origin aj CF vracajú **200** + valid XML pre `/sitemap.xml`.  
Ak GSC stále hlási chybu → **Cloudflare blokuje Googlebot** (403/challenge), nie nginx.

## 1. Cloudflare — Security → Events (najprv)

1. Prihlás sa do [Cloudflare](https://dash.cloudflare.com) → zóna **jasnelabs.eu**
2. **Security → Events**
3. Filter: URI Path = `/sitemap.xml` (posledných 24 h)
4. Hľadaj **Block**, **Challenge**, **Managed Challenge** pri user-agent Googlebot

Ak vidíš block → pokračuj krok 2.

## 2. WAF pravidlo — povoliť verified bots (odporúčané)

**Security → WAF → Custom rules → Create rule**

| Pole | Hodnota |
|------|---------|
| Názov | `Allow Googlebot sitemap robots` |
| Expression | `(http.request.uri.path eq "/sitemap.xml" or http.request.uri.path eq "/robots.txt" or http.request.uri.path eq "/") and cf.client.bot` |
| Action | **Skip** |
| Skip | All remaining custom rules, **Super Bot Fight Mode**, **All managed rules** |

Ulož → **Deploy**.

Alternatíva (širšia, ak stále padá):

```
(cf.client.bot) or (http.user_agent contains "Googlebot")
```

Action: Skip (rovnaké skip komponenty) — len ak verified-bot pravidlo nestačí.

Referencia: [Cloudflare fake bot rules](https://developers.cloudflare.com/waf/troubleshooting/fake-bot-managed-rules/) · [Kwebby CF + Googlebot](https://kwebby.com/blog/how-to-fix-cloudflare-blocking-googlebot-firewall-waf-bots/)

## 3. Bot Fight Mode

**Security → Bots → Bot Fight Mode** → **Off**  
(alebo nechaj On + krok 2 musí skipnúť Super Bot Fight Mode)

## 4. Managed robots.txt (voliteľné)

**Scrape Shield** (alebo **Bots**) → vypni **Cloudflare Managed robots.txt**  
Origin `robots.txt` je jednoduchý a obsahuje `Sitemap:` riadok. CF managed verzia pridáva Content-Signal blok — zriedka mätie GSC.

## 5. GSC — znova odoslať

1. Property **Domain** `jasnelabs.eu`
2. Sitemaps → ⋮ Odstrániť starý riadok
3. Pridať: **`https://www.jasnelabs.eu/sitemap.xml`**
4. **Kontrola URL** → vlož tú istú URL → **Test live URL**  
   - Ak vidíš **403** / **Failed** → stále CF block (krok 2–3)
   - Ak **200** → počkaj 30 min na Sitemaps

## 6. Overenie z prehliadača

https://www.jasnelabs.eu/sitemap.xml — musí byť XML (1 URL homepage).

---

**Prečo curl funguje a GSC nie:** curl z nášho servera prejde CF inak ako **verified Googlebot z Google IP**. CF WAF pravidlá „Fake Google Bot“ často blokujú GSC fetch, hoci manuálny test s UA `Googlebot` prejde.
