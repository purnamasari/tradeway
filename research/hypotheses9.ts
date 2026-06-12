// Round-9: final composition, pre-registered before its canonical run.
//
//   H18 = H17 + skip-ranging:
//     7d (672-bar) Donchian close-break, taken only when
//       (a) the 30d return agrees in sign with the break and |r30d| >= 5%
//           (H14's TSMOM filter, fixed in round 5 on BTC), and
//       (b) the 15m regime engine does NOT label "ranging" at entry
//           (H16's gate, fixed in round 6 on BTC).
//     SL 2·ATR1h, chandelier trail 4·ATR1h, 14d horizon, 2h entry TTL.
//
// Evidence trail: H17 was designed/parameterized on BTC only, then showed
// +0.192R net (n=687) on 7 alts 2023-01..2025-02 and +0.201R net (n=451,
// formal ACCEPT) on 8 alts 2025-03..2026-05 — its only consistent weak bucket
// was ranging entries. The ranging gate is the other registered component.
// Canonical verdict: pooled 41 months × 9 symbols under the standard scaled
// rule (>=60% of qualifying months positive, >=100 fills, no counted regime
// bucket below -0.15R net).
import type { Hypothesis } from "./harness.js";
import { HYPOTHESES6 } from "./hypotheses6.js";

const h17 = HYPOTHESES6.find((h) => h.name === "H17_turtle_tsmom_filter")!;

export const HYPOTHESES9: Hypothesis[] = [
  {
    name: "H18_turtle_tsmom_noranging",
    rule: (v) => (v.regime.regime === "ranging" ? null : h17.rule(v)),
  },
];
