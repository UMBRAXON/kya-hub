# Publish `@umbraxon_kya/kya-verify` to npm

npm už **nemá Classic tokeny** (od 11/2025). Používaj **Granular access token** alebo **Trusted Publishing**.

## A) Trusted Publisher (najlepšie — bez tokenu v GitHube)

1. https://www.npmjs.com → org **umbraxon_kya**
2. **Access** → **Trusted publishing** → **GitHub Actions**
   - Repository: `UMBRAXON/kya-hub`
   - Workflow: `publish-kya-verify-npm.yml`
3. Actions → **Publish @umbraxon_kya/kya-verify to npm** → `publish`

## B) Granular access token (tvoj screenshot)

Pri vytváraní tokenu:

| Pole | Hodnota |
|------|---------|
| Token name | `github-actions-publish` |
| Bypass 2FA | **áno** (pre CI / server publish) |
| Packages | **Read and write** → All packages |
| Organization | **umbraxon_kya** (presný názov — scope `@umbraxon_kya`) |

Po **Generate token** skopíruj **celý** reťazec (dlhý, začína `npm_`).

### Server (možnosť C)

```bash
echo -n 'CELY_TOKEN_Z_NPM' > /root/kya-hub/.secrets/npm-publish-token.txt
chmod 600 /root/kya-hub/.secrets/npm-publish-token.txt
/root/kya-hub/scripts/publish-kya-verify-local.sh
```

`echo -n` = bez Enter na konci. **Nepridávaj** druhé `npm_`.

### GitHub secret

Settings → Secrets → `NPM_TOKEN` = ten istý celý token.

## Overenie

https://www.npmjs.com/package/@umbraxon_kya/kya-verify
