#!/usr/bin/env bash
# Download Binance USDT-M futures monthly dumps (15m klines + funding) into
# research/binance-raw/ and convert them to the harness cache format.
# Designed to run on the server (Linux: curl + unzip). Resumable: existing
# CSVs are skipped, so re-running only fetches what is missing.
#
#   ./fetch-binance.sh "ETHUSDT SOLUSDT" 2025-03 2026-05        # window set -> BN_*
#   EPOCH=23 ./fetch-binance.sh "ETHUSDT SOLUSDT" 2023-01 2025-02  # epoch set -> BN23_*
#
# Defaults: all non-BTC research symbols over both ranges (BTC is already done
# locally). Run with no args to fetch everything that is missing.
set -uo pipefail
cd "$(dirname "$0")/binance-raw" 2>/dev/null || { mkdir -p "$(dirname "$0")/binance-raw"; cd "$(dirname "$0")/binance-raw"; }

SYMBOLS="${1:-ETHUSDT SOLUSDT HYPEUSDT ZECUSDT XRPUSDT DOGEUSDT LINKUSDT AVAXUSDT}"
FROM="${2:-2023-01}"
TO="${3:-2026-05}"
BASE="https://data.binance.vision/data/futures/um/monthly"

months() { # list YYYY-MM from $1 to $2 inclusive
  local cur="$1-01" end="$2-01"
  while [[ "${cur%-01}" < "$2" || "${cur%-01}" == "$2" ]]; do
    echo "${cur%-01}"
    cur=$(date -d "$cur +1 month" +%Y-%m-01)
  done
}

fetch() { # $1=url $2=zipname — skip if csv already extracted; 404s are fine (pre-listing months)
  [[ -f "${2%.zip}.csv" ]] && return 0
  curl -sf -m 120 -o "$2" "$1" || { rm -f "$2"; return 0; }
  unzip -oq "$2" && rm -f "$2"
}

for s in $SYMBOLS; do
  for ym in $(months "$FROM" "$TO"); do
    fetch "$BASE/klines/$s/15m/$s-15m-$ym.zip" "$s-15m-$ym.zip"
    fetch "$BASE/fundingRate/$s/$s-fundingRate-$ym.zip" "$s-fundingRate-$ym.zip"
  done
  echo "$s: $(ls "$s"-15m-*.csv 2>/dev/null | wc -l) kline months on disk"
done

cd ..
SYMS_CSV=$(echo "$SYMBOLS" | tr ' ' ',')
if [[ "${EPOCH:-}" == "23" ]]; then
  pnpm exec tsx convert-binance.ts --epoch=23 --symbols="$SYMS_CSV"
else
  pnpm exec tsx convert-binance.ts --symbols="$SYMS_CSV"
fi
