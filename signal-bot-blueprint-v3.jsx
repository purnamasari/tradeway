import { useState } from "react";

// ─── PRIMITIVES ───────────────────────────────────────────────────────────────

const Badge = ({ children, color = "green", size = "sm" }) => {
  const colors = {
    green:  { bg: "#0d2e1a", text: "#4ade80", border: "#166534" },
    red:    { bg: "#2e0d0d", text: "#f87171", border: "#7f1d1d" },
    yellow: { bg: "#2e250d", text: "#facc15", border: "#713f12" },
    blue:   { bg: "#0d1b2e", text: "#60a5fa", border: "#1e3a5f" },
    purple: { bg: "#1a0d2e", text: "#c084fc", border: "#4c1d95" },
    gray:   { bg: "#1a1a1a", text: "#9ca3af", border: "#374151" },
    orange: { bg: "#2e1a0d", text: "#fb923c", border: "#7c2d12" },
    teal:   { bg: "#0d2e2e", text: "#2dd4bf", border: "#0f766e" },
  };
  const c = colors[color] || colors.gray;
  return (
    <span style={{
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
      borderRadius: "4px", padding: size === "lg" ? "4px 12px" : "2px 8px",
      fontSize: size === "lg" ? "13px" : "11px",
      fontFamily: "'DM Mono', monospace", fontWeight: 500,
      letterSpacing: "0.04em", whiteSpace: "nowrap",
    }}>{children}</span>
  );
};

const Code = ({ children }) => (
  <pre style={{
    background: "#060606", border: "1px solid #1a1a1a", borderRadius: "8px",
    padding: "14px 18px", fontFamily: "'DM Mono', monospace", fontSize: "11.5px",
    color: "#a3e635", overflowX: "auto", lineHeight: 1.75, margin: "10px 0",
  }}><code>{children}</code></pre>
);

const Block = ({ children, style = {} }) => (
  <div style={{
    background: "#0e0e0e", border: "1px solid #1f1f1f",
    borderRadius: "10px", padding: "18px 22px", marginBottom: "14px", ...style,
  }}>{children}</div>
);

const SectionTitle = ({ children, sub }) => (
  <div style={{ marginBottom: "24px" }}>
    <h2 style={{ fontFamily: "'Syne', sans-serif", fontSize: "20px", fontWeight: 800, color: "#f0f0f0", margin: 0, letterSpacing: "-0.02em" }}>{children}</h2>
    {sub && <p style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#4b5563", margin: "5px 0 0" }}>{sub}</p>}
  </div>
);

const Warn = ({ children }) => (
  <div style={{ background: "#1a1200", border: "1px solid #713f12", borderRadius: "8px", padding: "12px 16px", marginBottom: "14px", display: "flex", gap: "10px" }}>
    <span style={{ fontSize: "14px", flexShrink: 0 }}>⚠️</span>
    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#d97706", lineHeight: 1.6 }}>{children}</span>
  </div>
);

const Info = ({ children, color = "#4ade80" }) => (
  <div style={{ background: "#0a0e0a", border: `1px solid ${color}20`, borderRadius: "8px", padding: "12px 16px", marginBottom: "14px", display: "flex", gap: "10px" }}>
    <span style={{ fontSize: "14px", flexShrink: 0 }}>ℹ️</span>
    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#6b7280", lineHeight: 1.6 }}>{children}</span>
  </div>
);

const Row = ({ label, value }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #111" }}>
    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#6b7280" }}>{label}</span>
    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "12px", color: "#e5e7eb" }}>{value}</span>
  </div>
);

const Check = ({ children, color = "#4ade80" }) => (
  <div style={{ display: "flex", gap: "10px", padding: "6px 0", borderBottom: "1px solid #111", alignItems: "flex-start" }}>
    <span style={{ color, fontSize: "11px", flexShrink: 0, marginTop: "1px" }}>✓</span>
    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#d1d5db", lineHeight: 1.5 }}>{children}</span>
  </div>
);

// ─── SECTION: SEPARATION OF CONCERNS ─────────────────────────────────────────

const SeparationSection = () => (
  <div>
    <SectionTitle sub="P1 · Dua komponen yang menjawab pertanyaan berbeda — tidak saling menggantikan">Regime Engine vs AI Trend Classifier</SectionTitle>

    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "20px" }}>
      {/* Regime Engine */}
      <div style={{ background: "#0a0e1a", border: "1px solid #1e3a5f", borderRadius: "10px", padding: "20px" }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "14px" }}>
          <span style={{ fontSize: "20px" }}>🌡</span>
          <div>
            <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: "15px", color: "#60a5fa" }}>Regime Engine</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#374151", marginTop: "2px" }}>rule-based · every 30 min · cached 25 min</div>
          </div>
        </div>

        <div style={{ background: "#080808", borderRadius: "8px", padding: "12px 14px", marginBottom: "14px" }}>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#4b5563", marginBottom: "6px" }}>PERTANYAAN YANG DIJAWAB</div>
          <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: "13px", color: "#f0f0f0" }}>
            "Kondisi market sekarang cocok untuk strategy apa?"
          </div>
        </div>

        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#4b5563", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Output</div>
        {["trending → enable trend_pullback", "ranging → enable liquidity_sweep", "high_volatility → enable squeeze", "low_volatility → disable all"].map((item, i) => (
          <div key={i} style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#9ca3af", padding: "5px 0", borderBottom: "1px solid #111" }}>{item}</div>
        ))}

        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#4b5563", marginTop: "12px", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Inputs (pure math)</div>
        {["ADX(14) — trend strength", "ATR percentile vs 30d — volatility", "EMA 20/50 spread — fanning/converging", "Funding extremity — bias indicator"].map((item, i) => (
          <div key={i} style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#6b7280", padding: "4px 0" }}>▸ {item}</div>
        ))}

        <div style={{ marginTop: "12px", padding: "10px", background: "#0d1b2e", borderRadius: "6px" }}>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#3b82f6", marginBottom: "4px" }}>TIDAK PUNYA AI DEPENDENCY</div>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#4b5563" }}>Jalan sendiri. Tidak butuh Claude, tidak butuh fallback.</div>
        </div>
      </div>

      {/* AI Trend Classifier */}
      <div style={{ background: "#100a1a", border: "1px solid #4c1d95", borderRadius: "10px", padding: "20px" }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "14px" }}>
          <span style={{ fontSize: "20px" }}>🤖</span>
          <div>
            <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: "15px", color: "#c084fc" }}>AI Trend Classifier</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#374151", marginTop: "2px" }}>Gemini 2.5 Flash · per-symbol · cached 30 min</div>
          </div>
        </div>

        <div style={{ background: "#080808", borderRadius: "8px", padding: "12px 14px", marginBottom: "14px" }}>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#4b5563", marginBottom: "6px" }}>PERTANYAAN YANG DIJAWAB</div>
          <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: "13px", color: "#f0f0f0" }}>
            "Ke arah mana momentum 4H bergerak sekarang?"
          </div>
        </div>

        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#4b5563", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Output</div>
        {["bullish → long setups diizinkan", "bearish → short setups diizinkan", "neutral → block semua directional entry"].map((item, i) => (
          <div key={i} style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#9ca3af", padding: "5px 0", borderBottom: "1px solid #111" }}>{item}</div>
        ))}

        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#4b5563", marginTop: "12px", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Inputs (4H candles)</div>
        {["Last 20 candles OHLCV 4H", "EMA 20/50 value", "Current price", "Structure: HH/HL atau LH/LL"].map((item, i) => (
          <div key={i} style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#6b7280", padding: "4px 0" }}>▸ {item}</div>
        ))}

        <div style={{ marginTop: "12px", padding: "10px", background: "#1a0d2e", borderRadius: "6px" }}>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#7c3aed", marginBottom: "4px" }}>ENHANCEMENT LAYER — BUKAN DEPENDENCY KRITIS</div>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#4b5563" }}>Kalau AI down → fallback ke EMA/ADX classifier. Scanner tidak berhenti.</div>
        </div>
      </div>
    </div>

    {/* Interaction diagram */}
    <Block>
      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4b5563", marginBottom: "14px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Bagaimana keduanya bekerja bersama</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {[
          {
            step: "1", label: "Regime Engine runs first",
            desc: "Classify: ranging/trending/high_vol/low_vol → tentukan strategy mana yang boleh jalan",
            color: "#60a5fa",
          },
          {
            step: "2", label: "AI Trend Classifier runs second",
            desc: "Classify: bullish/bearish/neutral → tentukan arah entry yang diizinkan",
            color: "#c084fc",
          },
          {
            step: "3", label: "Detector combine keduanya",
            desc: "Contoh: regime=ranging AND trend=bullish → liquidity_sweep long diizinkan",
            color: "#4ade80",
          },
          {
            step: "✗", label: "Yang TIDAK boleh terjadi",
            desc: "Regime engine tidak boleh override AI trend, dan sebaliknya. Dua layer independent.",
            color: "#f87171",
          },
        ].map(item => (
          <div key={item.step} style={{ display: "flex", gap: "14px", alignItems: "flex-start", padding: "10px 14px", background: "#0a0a0a", borderRadius: "8px", borderLeft: `3px solid ${item.color}` }}>
            <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: "16px", color: item.color, width: "20px", flexShrink: 0 }}>{item.step}</div>
            <div>
              <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: "13px", color: "#f0f0f0" }}>{item.label}</div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#6b7280", marginTop: "3px" }}>{item.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </Block>

    <Block>
      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4b5563", marginBottom: "10px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Contoh kombinasi Regime × Trend</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'DM Mono', monospace", fontSize: "11px" }}>
          <thead>
            <tr>
              {["Regime", "AI Trend", "Allowed Strategies", "Block"].map(h => (
                <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "#4b5563", borderBottom: "1px solid #1f1f1f", fontWeight: 400 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { regime: "ranging",        trend: "bullish",  allow: "liquidity_sweep LONG",  block: "trend_pullback", rc: "green",  tc: "green" },
              { regime: "ranging",        trend: "bearish",  allow: "liquidity_sweep SHORT", block: "trend_pullback", rc: "green",  tc: "red" },
              { regime: "trending",       trend: "bullish",  allow: "trend_pullback LONG",   block: "liquidity_sweep", rc: "blue", tc: "green" },
              { regime: "trending",       trend: "bearish",  allow: "trend_pullback SHORT",  block: "liquidity_sweep", rc: "blue", tc: "red" },
              { regime: "high_volatility",trend: "bullish",  allow: "short_squeeze",         block: "trend_pullback", rc: "orange", tc: "green" },
              { regime: "high_volatility",trend: "neutral",  allow: "squeeze (both)",        block: "sweep, pullback", rc: "orange", tc: "gray" },
              { regime: "low_volatility", trend: "any",      allow: "—",                     block: "ALL", rc: "gray", tc: "gray" },
            ].map((row, i) => (
              <tr key={i} style={{ borderBottom: "1px solid #111" }}>
                <td style={{ padding: "8px 12px" }}><Badge color={row.rc}>{row.regime}</Badge></td>
                <td style={{ padding: "8px 12px" }}><Badge color={row.tc}>{row.trend}</Badge></td>
                <td style={{ padding: "8px 12px", color: "#4ade80" }}>{row.allow}</td>
                <td style={{ padding: "8px 12px", color: "#f87171" }}>{row.block}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Block>
  </div>
);

// ─── SECTION: AI FALLBACK ─────────────────────────────────────────────────────

const FallbackSection = () => (
  <div>
    <SectionTitle sub="P1 · AI adalah enhancement layer. Scanner tidak boleh mati karena Gemini down.">AI Fallback Strategy</SectionTitle>

    <Warn>Kalau AI di-treat sebagai hard dependency, satu Gemini outage atau rate limit bisa membuat semua scanner berhenti. Fallback harus transparent — caller tidak perlu tahu apakah result dari AI atau dari rule engine.</Warn>

    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "16px" }}>
      <Block>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4b5563", marginBottom: "12px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Trigger Conditions untuk Fallback</div>
        {[
          { trigger: "Gemini Flash timeout",      detail: "> 5 detik tidak ada response", color: "red" },
          { trigger: "Rate limit (429)",         detail: "Gemini Flash quota tercapai → try Flash-Lite", color: "red" },
          { trigger: "Flash-Lite juga gagal",    detail: "Timeout / rate limit / 5xx", color: "red" },
          { trigger: "Cached result expired",   detail: "TTL habis + AI tidak bisa di-reach", color: "yellow" },
          { trigger: "JSON parse error",         detail: "AI return malformed response", color: "yellow" },
          { trigger: "Confidence < 40",          detail: "AI tidak yakin, fallback lebih reliable", color: "yellow" },
        ].map(item => (
          <div key={item.trigger} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid #111", gap: "10px" }}>
            <div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#e5e7eb" }}>{item.trigger}</div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#374151", marginTop: "2px" }}>{item.detail}</div>
            </div>
            <Badge color={item.color}>{item.color === "red" ? "FALLBACK" : "WARN"}</Badge>
          </div>
        ))}
      </Block>

      <Block>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4b5563", marginBottom: "12px", textTransform: "uppercase", letterSpacing: "0.08em" }}>EMA/ADX Fallback Classifier</div>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#6b7280", marginBottom: "10px", lineHeight: 1.6 }}>
          Pure rule-based. Tidak perlu API call. Menggunakan data yang sudah ada di Redis.
        </div>
        {[
          { rule: "Price > EMA20 > EMA50 AND ADX > 20",  result: "bullish",  note: "Clean uptrend structure" },
          { rule: "Price < EMA20 < EMA50 AND ADX > 20",  result: "bearish",  note: "Clean downtrend structure" },
          { rule: "EMA20 dan EMA50 flat (< 0.1% spread)", result: "neutral", note: "Ranging / no direction" },
          { rule: "ADX < 15 regardless of EMA",          result: "neutral",  note: "Tidak cukup momentum" },
          { rule: "Price antara EMA20 dan EMA50",        result: "neutral",  note: "Ambiguous, conservative" },
        ].map((item, i) => (
          <div key={i} style={{ padding: "8px 0", borderBottom: "1px solid #111" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#6b7280", flex: 1, lineHeight: 1.5 }}>{item.rule}</span>
              <Badge color={item.result === "bullish" ? "green" : item.result === "bearish" ? "red" : "gray"}>→ {item.result}</Badge>
            </div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#374151" }}>{item.note}</div>
          </div>
        ))}
      </Block>
    </div>

    <Block>
      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4b5563", marginBottom: "10px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Implementation (ai/trend-classifier.ts)</div>
      <Code>{`// ai/trend-classifier.ts
// 3-tier: Gemini 2.5 Flash → Flash-Lite → EMA/ADX
// Caller tidak tahu tier mana yang aktif — fully transparent

export interface TrendResult {
  trend: "bullish" | "bearish" | "neutral";
  confidence: number;         // 0–100
  source: "gemini_flash" | "gemini_flash_lite" | "ema_adx_fallback";
  reasoning?: string;         // only from Gemini
  key_levels?: { support: number; resistance: number };
}

// Shared Gemini config — both Flash and Flash-Lite
const GEMINI_GEN_CONFIG = {
  responseMimeType: "application/json",
  temperature: 0.1,       // low temp for classification task
  maxOutputTokens: 256,
};

export async function classifyTrend(
  symbol: string,
  candles4h: Candle[],
  ema20: number,
  ema50: number
): Promise<TrendResult> {

  // ── 1. Check Redis cache first ────────────────────────────────────
  const cacheKey = \`trend:\${symbol}\`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // ── 2. Try Gemini 2.5 Flash ───────────────────────────────────────
  try {
    const result = await Promise.race([
      callGemini("gemini-2.5-flash", symbol, candles4h, ema20, ema50),
      timeout(5000),
    ]);
    if (result.confidence >= 40) {
      await redis.setex(cacheKey, 1800, JSON.stringify(result));  // 30 min
      await logClassification(symbol, result);
      return result;
    }
    logger.warn(\`[trend] Flash low confidence \${result.confidence} for \${symbol}\`);
  } catch (err) {
    logger.warn(\`[trend] Flash failed for \${symbol}: \${err.message}\`);
    // Falls through to Flash-Lite regardless of error type
    // (rate limit 429, timeout, 5xx, parse error — all handled same way)
  }

  // ── 3. Try Gemini 2.5 Flash-Lite ─────────────────────────────────
  try {
    const result = await Promise.race([
      callGemini("gemini-2.5-flash-lite", symbol, candles4h, ema20, ema50),
      timeout(3000),  // tighter — Lite should respond faster
    ]);
    if (result.confidence >= 40) {
      await redis.setex(cacheKey, 900, JSON.stringify(result));   // 15 min — shorter, retry Flash sooner
      await logClassification(symbol, result);
      return { ...result, source: "gemini_flash_lite" };
    }
    logger.warn(\`[trend] Flash-Lite low confidence \${result.confidence} for \${symbol}\`);
  } catch (err) {
    logger.warn(\`[trend] Flash-Lite also failed for \${symbol}: \${err.message}\`);
  }

  // ── 4. EMA/ADX rule-based — all AI tiers exhausted ───────────────
  const fallback = emaAdxTrendClassifier(candles4h, ema20, ema50);
  await redis.setex(cacheKey, 600, JSON.stringify(fallback));     // 10 min — recheck AI soon
  await logClassification(symbol, fallback);
  return fallback;
}

function emaAdxTrendClassifier(candles4h: Candle[], ema20: number, ema50: number): TrendResult {
  const price = candles4h.at(-1)!.close;
  const adx   = calcADX(candles4h, 14);
  const emaSpreadPct = Math.abs(ema20 - ema50) / ema50;

  let trend: "bullish" | "bearish" | "neutral";
  if      (adx < 15 || emaSpreadPct < 0.001)              trend = "neutral";
  else if (price > ema20 && ema20 > ema50 && adx > 20)   trend = "bullish";
  else if (price < ema20 && ema20 < ema50 && adx > 20)   trend = "bearish";
  else                                                     trend = "neutral";

  return {
    trend,
    confidence: adx > 25 ? 70 : adx > 15 ? 55 : 40,
    source: "ema_adx_fallback",
  };
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(\`Timeout after \${ms}ms\`)), ms)
  );
}`}</Code>
    </Block>
  </div>
);

// ─── SECTION: RETENTION POLICY ───────────────────────────────────────────────

const RetentionSection = () => (
  <div>
    <SectionTitle sub="P1 · Metric history tidak boleh tumbuh tanpa batas">Metric Retention Policy</SectionTitle>

    <Info color="#f59e0b">Tanpa retention policy, metric_history table akan tumbuh ~50K rows/hari (5 symbols × 288 ticks/hari × beberapa metrics). Setelah 6 bulan: ~9 juta rows. Perlu cleanup dari awal.</Info>

    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "16px" }}>
      <Block>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4b5563", marginBottom: "12px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Retention Rules per Data Type</div>
        {[
          { type: "raw_metrics",         retention: "180 hari",  why: "Cukup untuk 90d percentile window + buffer" },
          { type: "aggregated_daily",    retention: "forever",   why: "Daily OHLCV + daily avg metrics — tiny, valuable" },
          { type: "signals",             retention: "forever",   why: "Trading history untuk analysis" },
          { type: "regime_log",          retention: "90 hari",   why: "Backtest regime classifications" },
          { type: "ai_trend_log",        retention: "90 hari",   why: "AI vs fallback accuracy tracking" },
          { type: "chart_png (R2)",      retention: "30 hari",   why: "Storage cost — regenerate dari signal jika perlu" },
          { type: "redis_cache",         retention: "TTL-based", why: "Auto-expire per key, tidak perlu cleanup" },
        ].map(item => (
          <div key={item.type} style={{ padding: "9px 0", borderBottom: "1px solid #111" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#e5e7eb" }}>{item.type}</span>
              <Badge color={item.retention === "forever" ? "green" : item.retention === "TTL-based" ? "blue" : "yellow"}>{item.retention}</Badge>
            </div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#374151", marginTop: "2px" }}>{item.why}</div>
          </div>
        ))}
      </Block>

      <div>
        <Block>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4b5563", marginBottom: "10px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Config (rules.yaml)</div>
          <Code>{`# config/rules.yaml
retention:
  raw_metrics:        180  # days
  aggregated_daily:   -1   # forever (-1)
  signals:            -1   # forever (-1)
  regime_log:         90
  ai_trend_log:       90
  chart_png_r2:       30

cleanup:
  schedule: "0 2 * * *"   # setiap hari jam 02:00 UTC
  batch_size: 1000         # delete in batches, tidak block DB
  vacuum_after: true       # VACUUM ANALYZE setelah delete`}</Code>
        </Block>

        <Block>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4b5563", marginBottom: "10px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Cleanup Job (BullMQ daily)</div>
          <Code>{`// queue/workers.ts
export async function runRetentionCleanup() {
  const config = loadRetentionConfig();
  const now = new Date();

  // raw_metrics
  if (config.raw_metrics > 0) {
    const cutoff = subDays(now, config.raw_metrics);
    await db.delete(metricHistory)
      .where(lt(metricHistory.recorded_at, cutoff));
  }

  // regime_log
  if (config.regime_log > 0) {
    const cutoff = subDays(now, config.regime_log);
    await db.delete(regimeLog)
      .where(lt(regimeLog.computed_at, cutoff));
  }

  // R2 chart PNGs — list and delete via R2 API
  if (config.chart_png_r2 > 0) {
    const cutoff = subDays(now, config.chart_png_r2);
    await deleteOldCharts(cutoff);  // R2 bucket cleanup
  }

  logger.info("[retention] Cleanup complete");
}

// Schedule: BullMQ cron
await cleanupQueue.add("daily-retention", {}, {
  repeat: { pattern: "0 2 * * *" },
  removeOnComplete: 10,
});`}</Code>
        </Block>
      </div>
    </div>
  </div>
);

// ─── SECTION: SETUP QUALITY SCORE ────────────────────────────────────────────

const QualitySection = () => (
  <div>
    <SectionTitle sub="P2 · Dua angka yang menjawab pertanyaan berbeda tentang sebuah signal">Setup Quality Score</SectionTitle>

    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "16px" }}>
      <div style={{ background: "#0a0e0a", border: "1px solid #166534", borderRadius: "10px", padding: "20px" }}>
        <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: "22px", color: "#4ade80", marginBottom: "4px" }}>Confidence</div>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "12px", color: "#6b7280", marginBottom: "16px" }}>
          "Seberapa besar kemungkinan setup ini berhasil?"
        </div>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#4b5563", marginBottom: "10px", textTransform: "uppercase" }}>Driven by: Market Conditions</div>
        {[
          { factor: "Funding percentile",    pts: "+35", note: "vs 90d window" },
          { factor: "OI z-score",            pts: "+30", note: "vs 90d window" },
          { factor: "Volume percentile",     pts: "+25", note: "vs 30d window" },
          { factor: "Regime alignment",      pts: "+10", note: "Strategy sesuai regime" },
        ].map(item => (
          <div key={item.factor} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #111" }}>
            <div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#d1d5db" }}>{item.factor}</div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#374151" }}>{item.note}</div>
            </div>
            <span style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, color: "#4ade80" }}>{item.pts}</span>
          </div>
        ))}
      </div>

      <div style={{ background: "#0e0a1a", border: "1px solid #4c1d95", borderRadius: "10px", padding: "20px" }}>
        <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: "22px", color: "#c084fc", marginBottom: "4px" }}>Setup Quality</div>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "12px", color: "#6b7280", marginBottom: "16px" }}>
          "Seberapa bersih struktur teknikal setup ini?"
        </div>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#4b5563", marginBottom: "10px", textTransform: "uppercase" }}>Driven by: Technical Structure (all formula-based)</div>
        {[
          { factor: "S/R level strength",    pts: "+30", note: "strength score 0–100 dari S/R engine ÷ 100 × 30" },
          { factor: "Engulf body ratio",      pts: "+25", note: "engulfBody / prevBody — capped at 1.0, scaled ×25" },
          { factor: "HTF alignment",          pts: "+20", note: "boolean: 4H level dalam 0.5% dari 15M level" },
          { factor: "Sweep wick ratio",       pts: "+15", note: "Sweep only: wickSize / candleBody — capped at 3.0, scaled ×5" },
          { factor: "Structure intact score", pts: "+10", note: "0 close violations in last 3×15M candles = +10, else 0" },
        ].map(item => (
          <div key={item.factor} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #111" }}>
            <div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#d1d5db" }}>{item.factor}</div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#374151" }}>{item.note}</div>
            </div>
            <span style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, color: "#c084fc" }}>{item.pts}</span>
          </div>
        ))}
      </div>
    </div>

    <Block>
      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4b5563", marginBottom: "10px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Updated Signal Output Schema</div>
      <Code>{`interface Signal {
  // ... existing fields ...

  confidence:    number;   // 0–100 — market conditions score
  setup_quality: number;   // 0–100 — technical structure score

  score_breakdown: {
    // Confidence components (market conditions)
    funding_percentile:  number;   // e.g. 8   → bottom 8% of 90d
    oi_zscore:           number;   // e.g. 2.1 → 2.1 std dev above mean
    volume_percentile:   number;   // e.g. 87  → top 13% of 30d
    regime_alignment:    number;   // 0 or 10
    // Setup quality components (all formula-based)
    sr_level_strength:   number;   // raw strength 0–100 from S/R engine
    engulf_body_ratio:   number;   // engulfBody / prevBody (e.g. 1.4)
    htf_aligned:         boolean;  // 4H level within 0.5% of 15M level
    sweep_wick_ratio?:   number;   // wickSize / candleBody (sweep only)
    structure_intact:    boolean;  // no close violations last 3×15M candles
  };
}

// ── Explainability Block — rendered in Telegram alert ────────────────
// Built from score_breakdown at alert-format time. No extra data needed.

function formatExplainability(signal: Signal): string {
  const b = signal.score_breakdown;
  const lines: string[] = [];

  // Confidence factors
  if (b.funding_percentile <= 10)
    lines.push(\`✓ Funding bottom \${b.funding_percentile}% of 90d\`);
  if (Math.abs(b.oi_zscore) >= 2.0)
    lines.push(\`✓ OI z-score \${b.oi_zscore > 0 ? "+" : ""}\${b.oi_zscore.toFixed(1)}\`);
  if (b.volume_percentile >= 80)
    lines.push(\`✓ Volume top \${(100 - b.volume_percentile).toFixed(0)}% of 30d\`);

  // Setup quality factors
  lines.push(\`✓ S/R strength \${b.sr_level_strength}\`);
  if (b.engulf_body_ratio >= 1.0)
    lines.push(\`✓ Engulf ratio \${b.engulf_body_ratio.toFixed(2)}×\`);
  if (b.htf_aligned)
    lines.push(\`✓ HTF 4H aligned\`);
  if (b.sweep_wick_ratio)
    lines.push(\`✓ Sweep wick \${b.sweep_wick_ratio.toFixed(2)}× body\`);

  return lines.join("\\n");
}

// Telegram alert output example:
// 🚨 ETH LONG · liquidity_sweep
// Confidence:    82 / 100
// Setup Quality: 88 / 100
// RR: 1:3.2
//
// Why?
// ✓ Funding bottom 8% of 90d
// ✓ OI z-score +2.1
// ✓ Volume top 13% of 30d
// ✓ S/R strength 91
// ✓ Engulf ratio 1.34×
// ✓ HTF 4H aligned
// ✓ Sweep wick 2.1× body`}</Code>
    </Block>
  </div>
);

// ─── SECTION: EXPECTED PATH ──────────────────────────────────────────────────

const PathSection = () => (
  <div>
    <SectionTitle sub="P2 · Calculated overlay — bukan static template. Approve/reject dalam 2 detik.">Expected Path Overlay</SectionTitle>

    <Info color="#fb923c">Path di-plot berdasarkan actual price levels, bukan generic template. Sweep marker di actual sweep candle. Trajectory ke TP berdasarkan actual price distance.</Info>

    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginBottom: "16px" }}>
      {[
        {
          strategy: "liquidity_sweep",
          color: "#4ade80",
          steps: [
            { label: "↓ Sweep wick", detail: "Arrow DOWN di actual sweep candle" },
            { label: "↑ Reclaim", detail: "Dot di actual reclaim candle close" },
            { label: "→ Entry zone", detail: "Shaded band: entry_low – entry_high" },
            { label: "↑ Path ke TP", detail: "Dotted projection dari entry_high ke TP" },
          ],
        },
        {
          strategy: "trend_pullback",
          color: "#60a5fa",
          steps: [
            { label: "↓ Pullback zone", detail: "Shaded area: S/R level ± 0.5%" },
            { label: "✓ Reclaim candle", detail: "Marker di 1M trigger candle" },
            { label: "→ Entry zone", detail: "Band di level reclaim" },
            { label: "↑ Continuation", detail: "Dotted path ke sebelumnya swing high" },
          ],
        },
        {
          strategy: "squeeze",
          color: "#c084fc",
          steps: [
            { label: "⟳ Build-up zone", detail: "Horizontal band: ranging area" },
            { label: "→ Watch level", detail: "Line: resistance/support minor" },
            { label: "↑/↓ Breakout", detail: "Arrow di actual trigger candle" },
            { label: "↑/↓ Path", detail: "Dotted projection ke TP (fast move)" },
          ],
        },
      ].map(item => (
        <Block key={item.strategy} style={{ borderLeft: `3px solid ${item.color}` }}>
          <Badge color={item.color === "#4ade80" ? "green" : item.color === "#60a5fa" ? "blue" : "purple"}>{item.strategy}</Badge>
          <div style={{ marginTop: "12px" }}>
            {item.steps.map((s, i) => (
              <div key={i} style={{ padding: "7px 0", borderBottom: "1px solid #111" }}>
                <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: "12px", color: "#f0f0f0" }}>{s.label}</div>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4b5563", marginTop: "2px" }}>{s.detail}</div>
              </div>
            ))}
          </div>
        </Block>
      ))}
    </div>

    <Block>
      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4b5563", marginBottom: "10px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Calculated Path Logic (chart/path-calculator.ts)</div>
      <Code>{`// chart/path-calculator.ts
// Called by renderer.ts — returns overlay data for template.html

export interface PathOverlay {
  markers: Array<{
    time: number;          // unix timestamp (candle time)
    position: "aboveBar" | "belowBar";
    shape: "arrowDown" | "arrowUp" | "circle" | "square";
    color: string;
    text?: string;
  }>;
  projectionLine: Array<{
    time: number;
    value: number;
  }>;
  zones: Array<{
    from: number;          // price
    to: number;            // price
    color: string;         // rgba
    label?: string;
  }>;
}

export function calculatePath(
  signal: Signal,
  candles1m: Candle[]
): PathOverlay {
  switch (signal.strategy) {

    case "liquidity_sweep": {
      // Find actual sweep candle (wick crosses S/R)
      const level = signal.direction === "long"
        ? signal.snapshot.support.price
        : signal.snapshot.resistance.price;

      const sweepCandle = candles1m.findLast(c =>
        signal.direction === "long"
          ? c.low < level * 0.995
          : c.high > level * 1.005
      );

      // Find reclaim candle (close back above/below level)
      const reclaimCandle = sweepCandle
        ? candles1m.slice(candles1m.indexOf(sweepCandle)).find(c =>
            signal.direction === "long"
              ? c.close > level
              : c.close < level
          )
        : null;

      // Project path from entry to TP (time-proportional)
      const entryPrice  = (signal.entry_low + signal.entry_high) / 2;
      const tpPrice     = signal.tp;
      const lastCandle  = candles1m.at(-1)!;
      const priceMove   = Math.abs(tpPrice - entryPrice);
      const timePerPct  = 60_000;  // rough: 1% move ≈ 1 candle
      const estCandles  = Math.round(priceMove / entryPrice * 100 * 3);

      return {
        markers: [
          sweepCandle && {
            time: sweepCandle.time,
            position: signal.direction === "long" ? "belowBar" : "aboveBar",
            shape: signal.direction === "long" ? "arrowDown" : "arrowUp",
            color: "#f87171",
            text: "sweep",
          },
          reclaimCandle && {
            time: reclaimCandle.time,
            position: signal.direction === "long" ? "aboveBar" : "belowBar",
            shape: "circle",
            color: "#facc15",
            text: "reclaim",
          },
        ].filter(Boolean),

        projectionLine: Array.from({ length: estCandles }, (_, i) => ({
          time: lastCandle.time + i * 60,
          value: entryPrice + (tpPrice - entryPrice) * (i / estCandles),
        })),

        zones: [{
          from: signal.entry_low,
          to: signal.entry_high,
          color: "rgba(250, 204, 21, 0.1)",
          label: "Entry",
        }],
      };
    }

    case "trend_pullback": {
      const level = signal.direction === "long"
        ? signal.snapshot.support.price
        : signal.snapshot.resistance.price;

      const triggerCandle = candles1m.at(-1)!;
      const prevSwingHigh = signal.tp;  // already calculated
      const entryPrice = (signal.entry_low + signal.entry_high) / 2;
      const estCandles = 20;

      return {
        markers: [{
          time: triggerCandle.time,
          position: signal.direction === "long" ? "aboveBar" : "belowBar",
          shape: signal.direction === "long" ? "arrowUp" : "arrowDown",
          color: "#4ade80",
          text: "entry",
        }],
        projectionLine: Array.from({ length: estCandles }, (_, i) => ({
          time: triggerCandle.time + i * 60,
          value: entryPrice + (prevSwingHigh - entryPrice) * (i / estCandles),
        })),
        zones: [{
          from: level * 0.995,
          to: level * 1.005,
          color: signal.direction === "long"
            ? "rgba(74, 222, 128, 0.08)"
            : "rgba(248, 113, 113, 0.08)",
          label: signal.direction === "long" ? "Support" : "Resistance",
        }],
      };
    }

    case "short_squeeze":
    case "long_squeeze": {
      const triggerCandle = candles1m.at(-1)!;
      const entryPrice = triggerCandle.close;
      const estCandles = 8;  // squeeze = fast

      return {
        markers: [{
          time: triggerCandle.time,
          position: signal.direction === "long" ? "belowBar" : "aboveBar",
          shape: signal.direction === "long" ? "arrowUp" : "arrowDown",
          color: "#c084fc",
          text: "squeeze trigger",
        }],
        projectionLine: Array.from({ length: estCandles }, (_, i) => ({
          time: triggerCandle.time + i * 60,
          value: entryPrice + (signal.tp - entryPrice) * (i / estCandles),
        })),
        zones: [],
      };
    }

    default:
      return { markers: [], projectionLine: [], zones: [] };
  }
}`}</Code>
    </Block>
  </div>
);

// ─── SECTION: ASSET PROFILES ─────────────────────────────────────────────────

const AssetSection = () => (
  <div>
    <SectionTitle sub="P3 · Asset class metadata untuk statistical analysis dan scanner tuning">Asset Profiles + Scanner Frequency</SectionTitle>

    <Info color="#2dd4bf">Asset profiles tidak mengubah detection logic. Dipakai untuk future analytics: win rate per asset class, regime sensitivity per class, dan scanner frequency tuning.</Info>

    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "16px" }}>
      <Block>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4b5563", marginBottom: "12px", textTransform: "uppercase", letterSpacing: "0.08em" }}>watchlist.yaml (updated)</div>
        <Code>{`# config/watchlist.yaml
global:
  min_confidence:        65
  min_setup_quality:     60   # NEW: quality gate
  alert_cooldown_min:    30
  max_alerts_per_hour:   10
  min_rr:                2.0

assets:
  BTCUSDT:
    enabled:       true
    scan_interval: 10          # minutes
    min_confidence: 70         # stricter — less false positives
    asset_class:   benchmark
    notes:         "Paling liquid, setup paling reliable"

  ETHUSDT:
    enabled:       true
    scan_interval: 10
    asset_class:   derivatives_leader
    notes:         "Funding/OI paling informatif di sini"

  SOLUSDT:
    enabled:       true
    scan_interval: 10
    asset_class:   momentum
    notes:         "Trending setup lebih sering muncul"

  ZECUSDT:
    enabled:       true
    scan_interval: 5            # 5 min — bergerak lebih agresif
    min_confidence: 65
    asset_class:   mean_reversion
    notes:         "Liquidity sweep lebih sering valid"

  HYPEUSDT:
    enabled:       true
    scan_interval: 5            # 5 min — volatil, squeeze frequent
    min_confidence: 75          # stricter — noise lebih tinggi
    max_position_size_multiplier: 0.5   # half size — volatility compensation
    asset_class:   squeeze_candidate
    notes:         "Squeeze setup paling sering di sini"
                   # Data baru — fallback threshold aktif > 90 hari`}</Code>
      </Block>

      <div>
        <Block>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4b5563", marginBottom: "12px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Asset Class Registry</div>
          {[
            { cls: "benchmark",          pair: "BTC",   trait: "Paling reliable, low noise. Best for trend_pullback." },
            { cls: "derivatives_leader", pair: "ETH",   trait: "Funding dan OI paling informatif. Good for squeeze." },
            { cls: "momentum",           pair: "SOL",   trait: "Strong trend moves. Best for trend_pullback." },
            { cls: "mean_reversion",     pair: "ZEC",   trait: "Range-bound tendencies. Best for liquidity_sweep." },
            { cls: "squeeze_candidate",  pair: "HYPE",  trait: "High funding extremity. Best for squeeze setups." },
          ].map(item => (
            <div key={item.cls} style={{ padding: "10px 0", borderBottom: "1px solid #111" }}>
              <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "4px" }}>
                <Badge color="teal">{item.cls}</Badge>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#6b7280" }}>{item.pair}</span>
              </div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#4b5563" }}>{item.trait}</div>
            </div>
          ))}
        </Block>

        <Block>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4b5563", marginBottom: "10px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Scanner Scheduler (per-asset interval)</div>
          <Code>{`// queue/workers.ts
// Scanner job dibuat per-asset, bukan satu job global

for (const asset of watchlist.assets) {
  if (!asset.enabled) continue;

  await scannerQueue.add(
    \`scan:\${asset.symbol}\`,
    { symbol: asset.symbol },
    {
      repeat: {
        every: asset.scan_interval * 60 * 1000,
      },
      // Jitter ±10 detik supaya tidak semua hit Redis bersamaan
      delay: Math.random() * 10_000,
    }
  );
}`}</Code>
        </Block>
      </div>
    </div>
  </div>
);

// ─── SECTION: SPRINT PLAN ────────────────────────────────────────────────────

const SprintSection = () => (
  <div>
    <SectionTitle sub="Final sprint plan — incorporating all v3 changes">Sprint Plan (Final)</SectionTitle>

    <Warn>Sprint 1 tidak berubah. Sprint 2 sekarang include retention policy dan asset profiles. Sprint 3 include AI fallback. Sprint 4 include quality score + path overlay.</Warn>

    {[
      {
        num: 1, title: "Data Collector", color: "#4ade80",
        additions: [],
        tasks: [
          { n: "Bybit WebSocket (ws)", d: "Subscribe kline 1m/15m/4h per symbol" },
          { n: "Redis OHLCV cache", d: "Key schema: market:{symbol}:{tf}" },
          { n: "OI + Funding poller", d: "BullMQ repeat job, setiap 5 menit" },
          { n: "metric_history table (Drizzle)", d: "Isi dari menit pertama — adaptive threshold butuh ini" },
          { n: "Per-asset scan interval", d: "BTC/ETH/SOL: 10m · ZEC/HYPE: 5m" },
          { n: "Asset profile config", d: "watchlist.yaml dengan class + scan_interval" },
        ],
      },
      {
        num: 2, title: "S/R Engine + Regime + Adaptive Thresholds + Retention", color: "#f59e0b",
        additions: ["+ Retention Policy cleanup job"],
        tasks: [
          { n: "S/R detector + ranker + clustering", d: "level-detector.ts + level-ranker.ts" },
          { n: "Prev Day/Week H/L", d: "High-weight S/R source dari REST API" },
          { n: "Regime engine", d: "ADX + ATR pct + EMA spread, cached 25m" },
          { n: "Adaptive threshold calculator", d: "Percentile + z-score + fallback untuk pair baru" },
          { n: "Retention cleanup job", d: "BullMQ daily cron, batch delete, VACUUM setelah cleanup" },
          { n: "ATR history accumulation", d: "Diperlukan regime engine — mulai sprint 1" },
        ],
      },
      {
        num: 3, title: "AI Classifier + Strategy Detectors", color: "#60a5fa",
        additions: ["+ AI Fallback (EMA/ADX classifier)"],
        tasks: [
          { n: "Gemini 2.5 Flash classifier + cache", d: "ai/trend-classifier.ts, 30m Redis cache" },
          { n: "Flash-Lite + EMA/ADX fallback", d: "3-tier: Flash → Flash-Lite → rule-based" },
          { n: "Regime × Trend gating", d: "Combination table: apa yang diizinkan per combo" },
          { n: "Liquidity Sweep detector", d: "Consume ranked S/R + adaptive thresholds" },
          { n: "Trend Pullback detector", d: "Gate: regime=trending, trend=bullish/bearish" },
          { n: "Squeeze pre-condition + WS trigger", d: "Two-phase architecture, Redis flag" },
        ],
      },
      {
        num: 4, title: "Signal Lifecycle + Quality Score + Chart + Telegram", color: "#c084fc",
        additions: ["+ Setup Quality Score", "+ Expected Path Overlay (calculated)"],
        tasks: [
          { n: "Signal model dengan confidence + setup_quality", d: "Dua field terpisah di schema" },
          { n: "Setup quality scorer", d: "S/R strength + pattern quality + HTF alignment" },
          { n: "Lifecycle: Detected → Sent → Expired", d: "BullMQ delayed expiry per strategy TTL" },
          { n: "Path calculator per strategy", d: "chart/path-calculator.ts — calculated, bukan static" },
          { n: "Chart renderer (Puppeteer + lightweight-charts)", d: "800×500px PNG, dark theme" },
          { n: "R2 upload + 30d retention", d: "chart_url di signal record" },
          { n: "Telegram bot (grammy)", d: "sendPhoto() dengan confidence + quality score" },
        ],
      },
    ].map(sprint => (
      <Block key={sprint.num} style={{ borderLeft: `3px solid ${sprint.color}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
          <div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4b5563", marginBottom: "3px" }}>SPRINT {sprint.num}</div>
            <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: "15px", color: "#f0f0f0" }}>{sprint.title}</div>
            {sprint.additions.map((a, i) => (
              <div key={i} style={{ fontFamily: "'DM Mono', monospace', fontSize: 11px", fontSize: "11px", color: "#f59e0b", marginTop: "3px" }}>v3 {a}</div>
            ))}
          </div>
          <Badge color="gray">planned</Badge>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          {sprint.tasks.map((t, i) => (
            <div key={i} style={{ display: "flex", gap: "10px" }}>
              <span style={{ color: "#374151", fontFamily: "'DM Mono', monospace", fontSize: "12px", flexShrink: 0 }}>▸</span>
              <div>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "12px", color: "#d1d5db" }}>{t.n}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: "11px", color: "#374151" }}> — {t.d}</span>
              </div>
            </div>
          ))}
        </div>
      </Block>
    ))}

    <Block style={{ background: "#0a1a0a", borderColor: "#166534" }}>
      <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4ade80", marginBottom: "12px", textTransform: "uppercase" }}>Blueprint v3 — Locked for Implementation</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px" }}>
        {[
          "Regime Engine (rule-based, no AI dependency)",
          "AI Trend Classifier + EMA/ADX fallback",
          "Regime × Trend separation documented",
          "S/R Engine dengan strength scoring",
          "Level clustering (0.3% threshold)",
          "Adaptive thresholds: 90d funding/OI, 30d vol/ATR",
          "Fallback untuk pair baru (< 30 days data)",
          "Metric retention policy: 180d raw, forever aggregated",
          "Signal lifecycle: Detected → Sent → Expired",
          "Market snapshot tersimpan di setiap signal",
          "Confidence (market) + Setup Quality (structure)",
          "Expected path overlay — calculated per strategy",
          "Asset profiles + scanner frequency per asset",
          "Chart renderer sebagai internal module",
          "Sprint 1 bisa mulai tanpa perubahan arsitektur lagi",
        ].map((item, i) => (
          <Check key={i}>{item}</Check>
        ))}
      </div>
    </Block>
  </div>
);

// ─── APP ──────────────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: "separation", label: "Regime vs AI Trend",    icon: "🔀", priority: "P1", new: true },
  { id: "fallback",   label: "AI Fallback",            icon: "🛡", priority: "P1", new: true },
  { id: "retention",  label: "Metric Retention",       icon: "🗑", priority: "P1", new: true },
  { id: "quality",    label: "Setup Quality Score",    icon: "⭐", priority: "P2", new: true },
  { id: "path",       label: "Expected Path Overlay",  icon: "📍", priority: "P2", new: true },
  { id: "assets",     label: "Asset Profiles",         icon: "🏷", priority: "P3", new: true },
  { id: "sprints",    label: "Sprint Plan (Final)",    icon: "🚀", priority: null },
];

const CONTENT = {
  separation: SeparationSection,
  fallback:   FallbackSection,
  retention:  RetentionSection,
  quality:    QualitySection,
  path:       PathSection,
  assets:     AssetSection,
  sprints:    SprintSection,
};

const PRIORITY_COLORS = { P1: "red", P2: "yellow", P3: "gray" };

export default function App() {
  const [active, setActive] = useState("separation");
  const Section = CONTENT[active];

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0e0e0e; }
        ::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }
      `}</style>

      <div style={{ display: "flex", height: "100vh", background: "#080808", overflow: "hidden" }}>
        {/* Sidebar */}
        <div style={{ width: "210px", minWidth: "210px", background: "#0a0a0a", borderRight: "1px solid #1a1a1a", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "20px 16px 12px" }}>
            <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: "14px", color: "#f0f0f0", letterSpacing: "-0.02em" }}>Signal Bot</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#374151", marginTop: "2px" }}>BLUEPRINT v3.0 · FINAL</div>
          </div>

          <div style={{ padding: "0 8px 6px 16px" }}>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "9px", color: "#374151", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "6px" }}>v3 additions only</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "9px", color: "#4b5563" }}>v2 components unchanged — see v2 blueprint for Stack, Regime Engine, S/R Engine, Adaptive Thresholds, Lifecycle, Chart Renderer, and Sprint Plan base.</div>
          </div>

          <div style={{ flex: 1, padding: "0 8px", overflowY: "auto" }}>
            {SECTIONS.map(s => (
              <button key={s.id} onClick={() => setActive(s.id)} style={{
                width: "100%", display: "flex", alignItems: "center", gap: "8px",
                padding: "9px 10px", borderRadius: "6px", border: "none",
                background: active === s.id ? "#1a1a1a" : "transparent",
                color: active === s.id ? "#f0f0f0" : "#4b5563",
                fontFamily: "'DM Mono', monospace", fontSize: "12px",
                textAlign: "left", cursor: "pointer", transition: "all 0.15s",
                marginBottom: "2px",
                borderLeft: active === s.id ? "2px solid #4ade80" : "2px solid transparent",
              }}>
                <span style={{ fontSize: "13px" }}>{s.icon}</span>
                <span style={{ flex: 1 }}>{s.label}</span>
                {s.priority && <Badge color={PRIORITY_COLORS[s.priority]}>{s.priority}</Badge>}
              </button>
            ))}
          </div>

          <div style={{ padding: "12px 16px", borderTop: "1px solid #1a1a1a" }}>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#4ade80", marginBottom: "6px" }}>✓ Ready to implement</div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: "10px", color: "#374151" }}>Sprint 1 dapat dimulai tanpa perubahan arsitektur.</div>
          </div>
        </div>

        {/* Main */}
        <div style={{ flex: 1, overflowY: "auto", padding: "32px" }}>
          <div style={{ maxWidth: "920px" }}>
            <Section />
          </div>
        </div>
      </div>
    </>
  );
}
