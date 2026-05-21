# Ako skopírovať dokumentáciu do Wordu

## Odporúčané: jeden súbor HTML (najlepšie formátovanie)

**Online (po deploy portálu):** https://www.umbraxon.xyz/operator-pack.html  
→ Súbor → Uložiť ako, alebo otvor stiahnutý `.html` v Microsoft Word.

**Z repozitára:**

1. Otvor v počítači súbor:
   ```
   docs/export/UMBRAXON-OPERATOR-PACK.html
   ```
   (Kópia pre web: `portal/public/operator-pack.html` — po úprave HTML spusti `cp docs/export/UMBRAXON-OPERATOR-PACK.html portal/public/operator-pack.html` a rebuild portálu.)
2. **Microsoft Word** → Súbor → Otvoriť → vyber tento `.html` súbor.
3. Word naimportuje nadpisy, tabuľky a farby. Ulož ako `.docx` (Súbor → Uložiť ako).

Alternatíva bez Wordu na serveri:

- Skopíruj súbor na laptop (SCP, GitHub raw, alebo otvor repo v Cursor).
- Alebo v prehliadači: pravý klik na súbor → Open with → Word.

## Metóda 2: Prehliadač → Word

1. Dvojklik na `UMBRAXON-OPERATOR-PACK.html` (otvorí Chrome/Firefox).
2. `Ctrl+A` (všetko), `Ctrl+C`.
3. Vo Worde: **Vložiť → Ponechať formátovanie zdroja** (Keep Source Formatting).

## Metóda 3: Jednotlivé markdown súbory

Ak chceš len 90-dňový plán bez balíka:

| Súbor | Obsah |
|-------|--------|
| `docs/GO-TO-MARKET-90-DAYS.md` | Plán 90 dní |
| `docs/WHERE-TO-FIND-INTEGRATORS.md` | Kanály |
| `docs/WHAT-WE-ARE-NOT.md` | Dôvera |
| `docs/OPS-SLA-DRAFT.md` | SLA draft |

Vo Worde: vložíš markdown ako čistý text — **tabuľky sa rozbijú**. Preto je lepší HTML balík.

Tip: [Pandoc](https://pandoc.org) na PC:

```bash
pandoc docs/export/UMBRAXON-OPERATOR-PACK.html -o UMBRAXON-OPERATOR-PACK.docx
```

## Čo obsahuje OPERATOR-PACK.html

- Pitch pre investora/partnera
- Čo sme / nie sme
- Snapshot verejných metrík
- 90-dňový GTM (mesiac 1–3, týždne)
- Mapa kanálov + outreach šablóna
- Týždenný dashboard + cieľové čísla
- Verejné odkazy (integrators, status, API)

Pred dôležitým meetingom obnov čísla z:

https://www.umbraxon.xyz/api/protocol/public-metrics

Posledná aktualizácia: 2026-05-19
