#!/usr/bin/env bash
# Build the BNALL_* candle caches needed by `pnpm test:h18:replay` on a fresh
# checkout (the caches are gitignored — ~40MB/symbol of 15m candles).
#
#   ./research/fetch-replay-data.sh                      # BTCUSDT ETHUSDT (replay default)
#   ./research/fetch-replay-data.sh "BTCUSDT ETHUSDT ZECUSDT XRPUSDT"
#
# Pipeline: download Binance Vision monthly dumps for both research windows
# (2023-01..2025-02 and 2025-03..2026-05), convert to BN23_/BN_ caches, then
# concatenate into BNALL_. Needs: curl, unzip, GNU date (standard on Ubuntu).
# Re-runnable: already-extracted months are skipped.
set -euo pipefail
cd "$(dirname "$0")"

SYMS="${1:-BTCUSDT ETHUSDT}"

command -v unzip >/dev/null || { echo "unzip is required (apt install unzip)"; exit 1; }

echo "== window 2025-03..2026-05 -> BN_*"
./fetch-binance.sh "$SYMS" 2025-03 2026-05

echo "== epoch 2023-01..2025-02 -> BN23_*"
EPOCH=23 ./fetch-binance.sh "$SYMS" 2023-01 2025-02

echo "== concatenating -> BNALL_*"
cd .. && pnpm exec tsx research/concat-all.ts

echo "done — run: pnpm test:h18:replay"
