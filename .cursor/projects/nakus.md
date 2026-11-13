# nakus — karta (token-light)

| | |
|--|--|
| **Repo** | `/root/nakus-project` |
| **Live** | `www.nakus.sk` → Next `:3002` (homepage = porovnávač, nie Vite) |
| **North star** | **Monopol:** €/kus·€/kg·€/pranie + doprava (landed). Heureka = cena balenia. Nie klon. Rule `nakus-unit-monopoly.mdc` |
| **Dáta** | XML first; scraping fallback |
| **Kontext** | `docs/PROJECT-CONTEXT.md` (START) → `PROJECT-LOG.md` → `npm run pipeline:health` |
| **Live segmenty** | 22 · +`
/ustna-voda` (€/ml) · +`/zubna-pasta` · SoT `catalog-categories.ts` · `audit:segment-wiring` |
| **Pairing** | **2026-11-12 CRITICAL 0** · DG Ristretto Barista ≡ Espresso Barista (EAN 7613036867580) |
| **Deploy UI** | `NAKUS_FORCE_RESTART=1 npm run web:up` (+ auto warmup hubov; `NAKUS_SKIP_WARM=1` skip) |
| **Engine DB lock** | `catalog/.cron-engine-db.lock` · FIFO fronta do **07:00 UTC** (`lib-engine-lock.sh`) · orphan `.holder` cleanup · ensure 180 s / B2B fd9 7200 · `npm run audit:engine-lock` · watchdog 09:00 |
| **Nerobiť** | Full `feedo:sync` / pipeline v chate ak health OK (cron) |
| **Zoohit affiliate** | Dáta Awin CSV; outbound **len** Dognet (`NAKUS_AFFILIATE_TEMPLATE_ZOOHIT`) — sync hard-fail bez template |
| **Affiliate owner IDs** | Dognet `hrELSt0G` · eHUB `cccc4a09` · CJ `101770191` · AffPort `8456` — lock: ingest + `pipeline:health` `affiliate_owner_gap` + cron 05:48 UTC Telegram |
| **Affiliate €** | eHUB API = **CZK** → EUR (`NAKUS_EHUB_CZK_PER_EUR` default 25). Order 190800407 = **31,93 Kč ≈ 1,28 €** (nie 31 €). |
| **Order atribúcia** | `ops:attribute-orders` → jsonl + **TG alert** každých 20 min · A+B: nk_sid mint + `campaign_merchant_fallback` keď eHUB `/` · CJ `clickReferringURL` |
| **CEO scorecard** | `ops:ceo-scorecard` · channel×segment×€ + /out + GSC + **product funnel** + demand gaps · pondelok pred weekly · `ceo-weekly-scorecard-latest.json` |
| **Ops must-track** | `ops:product-performance` · `merchant-scorecard` · `price-position` · `assortment-coverage` · `demand-ledger` · `/out?rk&src&ps` |
| **Bing** | **#41 auto OK** · denne 13:30 SK · mix **~70 % Cite + 30 % PDP** (+ GEO 1–2) · SubmitUrlBatch 100 + **TG** · `docs/BING-WEBMASTER-API.md` |
| **GSC** | **#62 OK** · cron OFF · owner denne vyžiada 11 URL · confirmed **484** |
| **IndexNow / Bing** | Po GSC OK: `npm run seo:indexnow:gsc`. Denný Bing API + IndexNow 13:30 SK. Weekly priority cron. Meta desc ≥~150. |
| **Blog AI** | **`/blog/sto-prani-od-persilu-po-euro-za-pranie`** · `/blog/avivaz-4x-balenie-nie-lacnejsie` · `/blog/bella-happy-before-newborn-vs-new-born` · `/blog/masti-kremy-cena-za-gram` |
| **Cite Engine** | Standing · huby +**pranie/káva** (2026-11-13) · AI strip aj `/pranie` `/kava` · `llms-sync`→`web:up`→queue→GSC |
| **AI layer** | MCP v1.3.0 · CLI `npx github:UMBRAXON/nakus-mcp` · sameAs+Glama · GEO pack · Brave/prompt-lab · `docs/AI-MCP.md` |
| **Ďalší krok** | Owner: npm 2FA → Approve `nakus-mcp@1.3.3`. Index: „daj GSC/Bing“ → `catalog/ops/index-stash/` (bez URL dumpov). |
| **Answer / AI** | `/odpoved/*` (**201**) · last GSC OK **#62** krmivo · next = fresh na vyžiadanie |
| **chcemplienky** | **OFF 2026-11-09** — crawl bez affiliate; vymazané DB/crawler/export/cron/WAVE1 |
| **Partner contact** | Denný enrich ≥2 hub segmenty, skip affiliate-onboard (`ops:partner-contact-enrich`) → CSV — bez auto-send |
| **Site quality** | `ops:site-quality` · autoheal (`nakus_data_recon` + **`nakus_feed_manifest`**) · **`ops:revive-sites`** · PM2 `kya-web-uptime-watch` |
| **Data recon ack** | Potvrdený feed shrink → `catalog/ops/data-recon-ack.json` (bez 2. Telegramu) · ingest shrink-guard `<60%` |
| **Feed RAW shrink** | `snapshot:feed-manifest` · skip `NaKus rebuild` · autoheal `nakus_feed_manifest` (nie unknown) |
| **Free-ship filler** | PDP (+ hub offer table) same-merchant tip · **nie** `/odpoved/*` / blog · analytics → denný Telegram |
| **Outbound × sort** | Cookie `nk_cat_ctx` (last catalog sort) → `outbound-clicks.jsonl` · `npm run report:analytics` |
| **„Bez CSS“ za Siemens** | Nie deploy — **Zscaler** 403 na `/_next/static/*` + assety (HTML prejde). Over hotspot / allowlist `www.nakus.sk`. Proof: `/marketing/downloads/homepage-styled-proof-20260921/` |
| **UI šípky** | Kanon `NkCircleChevron` — plná brand oranžová **`#e88a2e`** + biely kotúč (späť/pager/expand/breadcrumb/select) |
| **GSC** | **#62 OK** · confirmed **484** · mix **1 GEO+7 Cite+3 PDP** · next fresh na vyžiadanie · `ops:gsc-demand-adapt` |
| **Geo analytics** | page_view → **DB-IP** city MMDB + geoip-lite fallback (bez IP) · `geo:update-db` · TG Otvorili (Cite/utm_term) |
| **Order metriky** | time_to_buy · cheapest · landing · returning · search · device · segment · geo · CJ/Dognet · `affiliate-orders.jsonl` |
| **SEO URL pick** | **Povinné** `audit:seo-index-fresh` · `seo:gsc-fresh` (Cite-first z `gsc-priority-queue.json`) · `seo:gsc-queue:build` · `seo:bing-fresh` |
| **Brit feed** | Merchant XML 404 · site rebuild brit.pet/sk · **SKU→EAN** `catalog/brit-sku-ean.json` (~66 %) v `brit:sync` · live ceny OK |
| **Session** | 2026-10-27 · sync OK · `pipeline:health` healthy |
| **Košík feed** | Owner ZIP 2026-10-26 OK (15635) · CJ advertiser **7641542** ZIP ešte 404 · local fallback · `docs/DATA-SOURCES-KOSIK.md` |
| **Ďalšia session** | GSC #57 reveal · SERP snippet live (plienky/protein/krmivo/Cite) · Meta #004 · Košík ZIP |

**Kde čo:** segmenty/filtre → PROJECT-CONTEXT §2–3; onboard merchant → `docs/engine/MERCHANT-ONBOARDING.md`; discovery → `docs/DISCOVERY-WORKFLOW.md`.
