#!/bin/bash
# Aplikuje SQL migrácie + nastaví heslo pre kyahub_app user z .env
# Použitie:
#   ./migrations/apply.sh                # aplikuje všetky migrácie
#   ./migrations/apply.sh --dry-run      # iba vypíše čo by sa stalo

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "❌ Nenájdený .env súbor v $ENV_FILE"
    exit 1
fi

# Načítaj env premenné (ignoruje komentáre a prázdne riadky)
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Vyžadované premenné
: "${DB_HOST:?DB_HOST nie je v .env}"
: "${DB_PORT:?DB_PORT nie je v .env}"
: "${DB_NAME:?DB_NAME nie je v .env}"
: "${DB_USER:?DB_USER nie je v .env}"  # SUPERUSER pre vytvorenie kyahub_app
: "${DB_PASSWORD:?DB_PASSWORD nie je v .env}"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

# Heslo pre app user — buď z .env (KYAHUB_APP_PASSWORD) alebo generuj
if [[ -z "${KYAHUB_APP_PASSWORD:-}" ]]; then
    # Generuj 32-znakové bezpečné heslo
    KYAHUB_APP_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)
    echo "ℹ️  Vygenerované nové heslo pre kyahub_app: $KYAHUB_APP_PASSWORD"
    echo "   Pridaj do .env: KYAHUB_APP_PASSWORD=$KYAHUB_APP_PASSWORD"
fi

export PGPASSWORD="$DB_PASSWORD"

apply_file() {
    local file="$1"
    local version
    version=$(basename "$file" .sql)
    
    # Skontroluj či už bola aplikovaná
    local already
    already=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc \
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'" 2>/dev/null || echo "")
    
    if [[ "$already" == "1" ]]; then
        local applied
        applied=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc \
            "SELECT 1 FROM schema_migrations WHERE version = '$version'" 2>/dev/null || echo "")
        if [[ "$applied" == "1" ]]; then
            echo "⏭  $version už aplikovaná, preskakujem"
            return 0
        fi
    fi

    echo "→ Aplikujem $version"
    if (( DRY_RUN )); then
        echo "   [dry-run] would run: psql ... < $file"
    else
        psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -f "$file"
    fi
}

# Aplikuj všetky .sql súbory v migrations/ podľa abecedy
echo "=== UMBRAXON KYA-Hub DB Migrácie ==="
echo "  DB: $DB_NAME @ $DB_HOST:$DB_PORT (user: $DB_USER)"
echo ""

for f in "$SCRIPT_DIR"/[0-9]*.sql; do
    [[ -f "$f" ]] || continue
    apply_file "$f"
done

# Nastav reálne heslo pre kyahub_app (nahradí placeholder z migrácie)
if (( ! DRY_RUN )); then
    echo "→ Nastavujem heslo pre kyahub_app"
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -c \
        "ALTER USER kyahub_app WITH PASSWORD '$KYAHUB_APP_PASSWORD';" > /dev/null
    echo "  ✓ heslo nastavené"
fi

# Test login ako kyahub_app
echo ""
echo "→ Testovanie pripojenia ako kyahub_app..."
if (( ! DRY_RUN )); then
    PGPASSWORD="$KYAHUB_APP_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U kyahub_app -d "$DB_NAME" -tAc \
        "SELECT 'OK', COUNT(*) FROM agents" 2>&1 | head -3
fi

echo ""
echo "✓ Migrácie aplikované."
echo ""
echo "🔐 NEZABUDNI: pridať do .env (ak ešte nie je):"
echo "    KYAHUB_APP_PASSWORD=$KYAHUB_APP_PASSWORD"
