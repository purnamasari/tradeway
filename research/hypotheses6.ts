// Round-6 pre-registered hypotheses — BTC-only, composition round.
//
// Round 5: H14 (TSMOM 30d, standalone) ≈ 0 net; H15 (Turtle 7d channel)
// +0.100R net over 242 fills but REJECTED for consistency — profits cluster
// in trend months and ranging-regime entries were toxic. The standard CTA
// construction is exactly this pair composed: a slow momentum FILTER deciding
// direction eligibility, a faster channel break TIMING the entry. Both
// components' parameters were fixed in round 5 and are reused verbatim.
//
//   H17 (principled): take the 7d Donchian close-break ONLY when the 30d
//        return agrees in sign and |r30d| >= 5%. Mechanics = H15 unchanged
//        (SL 2·ATR1h, chandelier trail 4·ATR1h, 14d TTL, 2h entry).
//
//   H16 (exploratory, bucket-informed — labeled as such): H15 gated to
//        regime != ranging at entry. Same caveat as H12/H13: the gate was
//        observed in our own breakdown, so it carries selection risk.
//
// Extra bar for BOTH (set before running): the standard verdict rule on the
// pooled 41 months AND net avgR > 0 on each sub-window separately
// (2023-01..2025-02, 2025-03..2026-05).
import type { Hypothesis } from "./harness.js";
import { HYPOTHESES5 } from "./hypotheses5.js";

const DAY_BARS = 96;
const turtle = HYPOTHESES5.find((h) => h.name === "H15_turtle_7d")!;

export const HYPOTHESES6: Hypothesis[] = [
  {
    name: "H17_turtle_tsmom_filter",
    rule: (v) => {
      const sig = turtle.rule(v);
      if (!sig) return null;
      if (v.i < 30 * DAY_BARS) return null;
      const now = v.c15full[v.i]!.close;
      const past = v.c15full[v.i - 30 * DAY_BARS]!.close;
      const r30 = (now - past) / past;
      if (sig.direction === "long" && r30 >= 0.05) return sig;
      if (sig.direction === "short" && r30 <= -0.05) return sig;
      return null;
    },
  },
  {
    name: "H16_turtle_noranging",
    rule: (v) => (v.regime.regime === "ranging" ? null : turtle.rule(v)),
  },
];
