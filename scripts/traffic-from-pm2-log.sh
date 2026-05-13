#!/usr/bin/env bash
# Zosumarizuje registrácie / webhook traffic z PM2 JSON logu kya-hub (kya-hub-out.log).
# Použitie:
#   ./scripts/traffic-from-pm2-log.sh
#   ./scripts/traffic-from-pm2-log.sh /root/.pm2/logs/kya-hub-out.log
#   ./scripts/traffic-from-pm2-log.sh /root/.pm2/logs/kya-hub-out*.log
# Premenné:
#   PM2_HUB_OUT_LOG  — predvolený jeden súbor, ak nepredáš argumenty (default: ~/.pm2/logs/kya-hub-out.log)
set -euo pipefail

usage() {
  sed -n '1,20p' "$0" | tail -n +2
  echo "Options:"
  echo "  -h, --help     Show this help"
  echo "  --csv          Machine-readable key=value lines"
  exit "${1:-0}"
}

CSV=0
FILES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --csv) CSV=1; shift ;;
    --) shift; FILES+=("$@"); break ;;
    -*) echo "Unknown option: $1" >&2; usage 1 ;;
    *) FILES+=("$1"); shift ;;
  esac
done

if [[ ${#FILES[@]} -eq 0 ]]; then
  FILES=("${PM2_HUB_OUT_LOG:-"$HOME/.pm2/logs/kya-hub-out.log"}")
fi

for f in "${FILES[@]}"; do
  if [[ ! -r "$f" ]]; then
    echo "error: not a readable file: $f" >&2
    exit 1
  fi
done

# Count lines matching needle (PM2 môže mať prefix `2026-05-13T12:00:00: ` pred JSON).
count_line() {
  local needle="$1"
  (grep -h -F -- "$needle" "${FILES[@]}" 2>/dev/null || true) | wc -l | tr -d ' '
}

# Webhook BTCPay handler lines; "webhook received" = typicky InvoiceSettled.
WH_RECV=$(count_line '"route":"webhook/btcpay"')
WH_SETTLED=$( (grep -h -F '"route":"webhook/btcpay"' "${FILES[@]}" 2>/dev/null || true) | grep -F 'webhook received' | wc -l | tr -d ' ')

MFR=$(count_line '"msg":"manufacturer check"')
INV_SIG=$(count_line 'bot signature INVALID')
AGENT_OK=$(count_line '"msg":"Agent zaregistrovaný"')
PDF_FAIL=$(count_line 'invoice PDF issue FAIL')
WH_EMPTY=$(count_line 'prázdny alebo nepodpísaný webhook')
WH_DUP=$(count_line 'duplicate webhook')
WH_FAIL=$(count_line 'webhook processing failed')
INTENT_FAIL=$(count_line 'intent INSERT FAIL')
INV_FAIL=$(count_line 'invoice create FAIL')
REG_ROUTE=$(count_line '"route":"register/initiate"')
PAY_ROUTE=$(count_line '"route":"pay"')
ACTION_ROUTE=$(count_line '"route":"agent/action"')
WH_ALBY=$(count_line '"route":"webhook/alby"')

# Minimum POST /api/register/initiate attempts inferred from mutually exclusive branches
# (INVALID is logged before manufacturer check; manufacturer implies valid signature path).
MIN_INITIATE=$((MFR + INV_SIG))

# Unique agentName on manufacturer-check lines (best-effort; redacted logs keep agentName).
mfr_agents=$( (grep -hF '"msg":"manufacturer check"' "${FILES[@]}" 2>/dev/null || true) | grep -oE '"agentName":"[^"]+"' | sort -u || true)
mfr_agent_count=$(printf '%s\n' "$mfr_agents" | sed '/^$/d' | wc -l | tr -d ' ')

reg_agents=$( (grep -hF '"msg":"Agent zaregistrovaný"' "${FILES[@]}" 2>/dev/null || true) | grep -oE '"agentName":"[^"]+"' | sort -u || true)
reg_agent_count=$(printf '%s\n' "$reg_agents" | sed '/^$/d' | wc -l | tr -d ' ')

if [[ "$CSV" == 1 ]]; then
  echo "log_files=${#FILES[@]}"
  echo "manufacturer_check=$MFR"
  echo "bot_signature_invalid=$INV_SIG"
  echo "min_post_register_initiate=$MIN_INITIATE"
  echo "register_initiate_log_lines=$REG_ROUTE"
  echo "webhook_btcpay_lines=$WH_RECV"
  echo "webhook_btcpay_invoice_settled=$WH_SETTLED"
  echo "agent_registered=$AGENT_OK"
  echo "invoice_pdf_fail_nonfatal=$PDF_FAIL"
  echo "webhook_empty_unsigned=$WH_EMPTY"
  echo "webhook_duplicate=$WH_DUP"
  echo "webhook_processing_failed=$WH_FAIL"
  echo "intent_insert_fail=$INTENT_FAIL"
  echo "invoice_create_fail=$INV_FAIL"
  echo "route_pay=$PAY_ROUTE"
  echo "route_agent_action=$ACTION_ROUTE"
  echo "route_webhook_alby=$WH_ALBY"
  echo "unique_agent_names_manufacturer_check=$mfr_agent_count"
  echo "unique_agent_names_registered=$reg_agent_count"
  exit 0
fi

echo "## KYA-Hub traffic (PM2 log)"
echo ""
echo "Súbory (${#FILES[@]}):"
for f in "${FILES[@]}"; do
  echo "- $f"
done
echo ""

echo "### Funnel registrácie (heuristika z JSON logov)"
echo ""
echo "| Metrika | Počet |"
echo "|---------|-------:|"
echo "| Riadky s \`\"route\":\"register/initiate\"\` (všetky úrovne logu z handlera) | $REG_ROUTE |"
echo "| \`manufacturer check\` (manifest + challenge OK) | $MFR |"
echo "| \`bot signature INVALID\` | $INV_SIG |"
echo "| Min. odhad \`POST /api/register/initiate\` (\`manufacturer\` + \`INVALID\`, disjunktné vetvy) | $MIN_INITIATE |"
echo "| \`intent INSERT FAIL\` | $INTENT_FAIL |"
echo "| \`invoice create FAIL\` (initiate) | $INV_FAIL |"
echo "| Webhook BTCPay: riadky s \`\"route\":\"webhook/btcpay\"\` | $WH_RECV |"
echo "| \`webhook received\` (InvoiceSettled, …) na btcpay route | $WH_SETTLED |"
echo "| \`Agent zaregistrovaný\` | $AGENT_OK |"
echo "| \`invoice PDF issue FAIL\` (non-fatal) | $PDF_FAIL |"
echo "| \`prázdny alebo nepodpísaný webhook\` | $WH_EMPTY |"
echo "| \`duplicate webhook\` | $WH_DUP |"
echo "| \`webhook processing failed\` | $WH_FAIL |"
echo ""
echo "### Ďalšie route v tomto výbere"
echo ""
echo "| Metrika | Počet |"
echo "|---------|-------:|"
echo "| \`\"route\":\"pay\"\` | $PAY_ROUTE |"
echo "| \`\"route\":\"agent/action\"\` | $ACTION_ROUTE |"
echo "| \`\"route\":\"webhook/alby\"\` | $WH_ALBY |"
echo ""

echo "### Unikátne \`agentName\` (grep z logu)"
echo ""
echo "**Po \`manufacturer check\` ($mfr_agent_count):**"
if [[ -n "$mfr_agents" ]]; then
  printf '%s\n' "$mfr_agents" | sed 's/^/- /'
else
  echo "(žiadne)"
fi
echo ""
echo "**Po \`Agent zaregistrovaný\` ($reg_agent_count):**"
if [[ -n "$reg_agents" ]]; then
  printf '%s\n' "$reg_agents" | sed 's/^/- /'
else
  echo "(žiadne)"
fi
echo ""
echo "---"
echo "Poznámka: skoršie odmietnutia (POW, rate limit, chybný manifest bez warn) sa v out log nemusia objaviť. Presné HTTP počty: nginx access log."
echo "CSV: \`$0 --csv /cesta/kya-hub-out.log\` (príp. viac súborov za sebou)"
