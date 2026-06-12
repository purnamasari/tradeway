// Round-4: ONE hypothesis, promoted from a bucket that recurred across three
// independent round-2/3 rules (H7 fixed-TP, H11 trail, H12 no-ranging): daily
// breakouts entered while 15m volatility is COMPRESSED (regime engine's
// low_volatility: trailing-30d ATR percentile <= 20) were +0.15..0.19R net in
// all three, while elevated-vol entries were flat/negative. Theory:
// volatility cycling — expansion follows contraction; a 24h-extreme break out
// of compression is the start of expansion, not its exhausted middle.
//
// Because that gate was OBSERVED in-sample on the 2025-03..2026-05 Binance
// window, H13's verdict comes from data it has never seen:
//   (a) epoch out-of-sample: 2023-01..2025-02 (8 symbols), and
//   (b) symbol out-of-sample: XRP/DOGE/LINK/AVAX on 2025-03..2026-05.
// Entry/exit mechanics are H11's unchanged: 96-bar Donchian close-break,
// initial SL 2·ATR1h, chandelier trail 3·ATR1h, 1h entry TTL, 7d horizon.
import type { Hypothesis } from "./harness.js";
import { HYPOTHESES3 } from "./hypotheses3.js";

const h11 = HYPOTHESES3.find((h) => h.name === "H11_donchian_trail")!;

export const HYPOTHESES4: Hypothesis[] = [
  {
    name: "H13_lowvol_breakout_trail",
    rule: (v) => (v.regime.regime === "low_volatility" ? h11.rule(v) : null),
  },
];
