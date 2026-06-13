# SMC_SCALP — investigation findings & decision

**Status: PARKED (backtest-only). Not validated, not live.**
**Date: 2026-06-13**

## What it is

`SMC_SCALP` (`src/strategies/smc-scalp.ts`) is a higher-frequency variant of the
validated `SMC` strategy, built to give a daytrader/scalper more signals. It
reuses the **same** `detectSmcSetup` core with a looser, faster parameter set
(`fvgMinAtr 0.75→0.35`, `sweepWindow 12→6`, `liqLookback 192→96`, `minRR
1.5→1.2`, `maxRR 3→2`, market-at-break entry `entryStyle 0→1`, 1h TTL / 8h hold).

The parameters were chosen **by analogy, not by a research round** — so it never
carried the validation H18/SMC do.

## How it was investigated

1. Backtested over the live watchlist (BTCUSDT, ETHUSDT, SOLUSDT, ZECUSDT,
   HYPEUSDT), 90 days, via `pnpm backtest -- --strategy=SMC_SCALP --days=90`.
2. The gate funnel (`src/engine/funnel.ts`) was wired into the backtest replay
   so each rejection is attributed to the gate that caused it. **Signal *count*
   is the trustworthy number here** — it is unaffected by the 15m-bar fill
   model; P&L/win/PF are not (see "Caveat" below).

## Result — 90d × 5 symbols (43,105 evaluations)

```
SMC_SCALP  evaluated=43105  signals=4
  regime  : reached 43105  passed 23389  (failed 19716)   54.3%
  bos     : reached 23389  passed  2329  (failed 21060)    5.4%
  sweep   : reached  2329  passed   344  (failed  1985)    0.8%
  fvg     : reached   344  passed    60  (failed   284)    0.1%
  sanity  : reached    60  passed    60  (failed     0)
  rr      : reached    60  passed     4  (failed    56)    0.0%   ← 93% killed here
```

Headline (untrustworthy, see caveat): 4 signals, 50% win, **−0.45 exp.R**, PF 0.17.

## Finding 1 — the setups exist; the *entry* starves them

The rare confluence (sweep → BOS → FVG) fired **60 times in 90 days** (~20/mo) —
respectable supply. The strategy then rejects **56 of 60 (93%) at the RR gate.**

Mechanism — the market-at-break entry (`entryStyle:1`) is self-defeating:

```
entry  ─────────●  (BOS close — buying at the top of the leg)
                │   entry→stop = the WHOLE sweep→break leg = large risk
sweep wick ─────●  (stop)
```

`RR = (target − entry) / (entry − stop)`. Entering at the break makes the
denominator large *and* the numerator small (you've already consumed most of the
distance to the next liquidity pool). RR collapses below `minRR` → rejected. This
is scale-independent: it's the entry geometry, not the absolute leg size.

`SMC` avoids this with a limit retrace entry (`entryStyle:0`) — it enters lower,
closer to the stop, so RR survives. That's why `SMC` produced 21 signals and
`SMC_SCALP` only 4.

## Finding 2 — 15m is structurally wrong for scalping

Two timeframe effects, both confirmed:

- **Supply.** A 15m bar averages away the intrabar sweep-and-reclaim a scalper
  trades. Far fewer scalp structures *exist* at 15m than at 1m/5m.
- **Timing.** The engine decides only at 15m bar close (`BAR_SEC = 900`). A
  sweep+BOS that completes mid-bar isn't actionable for up to 15 minutes — by
  then the move has extended, which is exactly what crushes the RR in Finding 1.
  The only scalp-like entry (market at break) is the one the timeframe makes
  unprofitable to act on.

And lowering the timeframe makes the **cost hurdle worse**, not better (more
trades × fixed ~0.11% round-trip taker fee). The research already found 15m-scale
rules die to the ~0.2–0.4R cost hurdle on these instruments; a 1m/5m scalp faces
a steeper version. The validated edges (H18 swing, SMC daytrade) live at
timeframes where the move is large enough to pay the toll.

## Caveat on the P&L

At the time of this investigation the plug-in backtest (`replayPluginSymbol`)
resolved entry/stop/target on **15m bars**, which manufactures artifacts for
tight-stop strategies (fill-and-stop in one bar) — so the `exp.R`/win%/PF above
were **not trustworthy**. **Update (2026-06-13): this was fixed** — the plug-in
backtest now resolves fills/stops/targets on **1m bars** (audit finding C2
closed), so P&L can be re-judged with a fresh run. The **decision below is
unchanged**: it rests on the gate funnel (signal *frequency*), which is
independent of the fill model.

## Decision

`SMC_SCALP` is **parked backtest-only** — removed from the live
`engine.strategies` list, kept registered in the backtest registry. There is no
real "scalp" available at 15m: the entry style that is scalp-like has dead RR,
and reverting it to a limit entry just reproduces `SMC`.

Two coherent paths remain, deferred to an explicit decision:

- **B — build a real lower-timeframe (1m/5m) engine** with 15m/1h as HTF
  context. Requires a per-strategy decision timeframe in the cycle and a
  1m-resolution backtest (which also fixes C2). The edge must clear a *harder*
  cost hurdle — eyes open.
- **C — drop the scalp ambition.** Run H18 + SMC (the validated edges); scalp
  manually. Most defensible given the cost reality.

Not recommended: continuing to tune SMC_SCALP on 15m (it only converges back
toward SMC) or lowering `minRR`/`fvgMinAtr` (spends edge for marginal setups).
