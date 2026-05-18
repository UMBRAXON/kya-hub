# Publish `@umbraxon_kya/kya-verify` to npm

## A) Trusted Publisher (recommended — no `NPM_TOKEN`)

1. https://www.npmjs.com → prihlás sa → organizácia **umbraxon_kya**
2. **Access** → **Trusted publishing** (alebo package → Publishing)
3. **Add trusted publisher** → **GitHub Actions**
   - Repository: `UMBRAXON/kya-hub`
   - Workflow: `publish-kya-verify-npm.yml`
   - Environment: *(prázdne)*
4. GitHub → **Actions** → **Publish @umbraxon_kya/kya-verify to npm** → Run → `publish`

## B) Fallback: `NPM_TOKEN` secret

Secret musí byť v **tom istom** repozitári ako workflow: `UMBRAXON/kya-hub`.

1. npm → **Access Tokens** → **Classic Token** → type **Automation**
2. GitHub → `kya-hub` → **Settings → Secrets → Actions** → `NPM_TOKEN`
3. Pri vkladaní **bez medzier a bez Enter na konci**

Granular token často zlyhá na `npm whoami` v CI — používaj Classic Automation.

## C) Publish zo servera (núdzovo)

```bash
echo 'npm_xxxx' > /root/kya-hub/.secrets/npm-publish-token.txt
chmod 600 /root/kya-hub/.secrets/npm-publish-token.txt
/root/kya-hub/scripts/publish-kya-verify-local.sh
```

## Overenie

https://www.npmjs.com/package/@umbraxon_kya/kya-verify
