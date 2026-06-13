// AI Trend Classifier — enhancement layer, NOT a hard dependency.
// 2-tier: OpenRouter (owl-alpha) -> EMA/ADX rule fallback.
// The caller never knows which tier produced the result.
import type { Candle, TrendResult } from "../types.js";
import type { Cache } from "../cache.js";
import type { Rules } from "../config.js";
import { adx, ema } from "../indicators.js";
import { logger } from "../logger.js";

interface Deps {
  cache: Cache;
  rules: Rules["trend"];
  geminiApiKey?: string;
}

export async function classifyTrend(
  symbol: string,
  candles1h: Candle[],
  ema20: number,
  ema50: number,
  deps: Deps,
): Promise<TrendResult> {
  const cacheKey = `trend:${symbol}`;
  const cached = await deps.cache.get(cacheKey);
  if (cached) return JSON.parse(cached) as TrendResult;

  // ── Tier 1: OpenRouter (owl-alpha) ──────────────────────────────────────────
  if (deps.geminiApiKey) {
    try {
      const result = await withTimeout(
        callOpenRouter(deps.geminiApiKey, symbol, candles1h, ema20, ema50),
        deps.rules.flash_timeout_ms,
      );
      if (result.confidence >= deps.rules.confidence_floor) {
        const final: TrendResult = { ...result, source: "openrouter_owl" };
        await deps.cache.setex(cacheKey, 1800, JSON.stringify(final));
        return final;
      }
      logger.warn(`[trend] owl-alpha low confidence ${result.confidence} for ${symbol}`);
    } catch (err) {
      logger.warn(`[trend] owl-alpha failed for ${symbol}: ${(err as Error).message}`);
    }
  }

  // ── Tier 2: EMA/ADX rule fallback ───────────────────────────────────────────
  const fallback = emaAdxTrendClassifier(candles1h, ema20, ema50);
  await deps.cache.setex(cacheKey, 600, JSON.stringify(fallback));
  return fallback;
}

export function emaAdxTrendClassifier(
  candles1h: Candle[],
  ema20: number,
  ema50: number,
): TrendResult {
  const price = candles1h.at(-1)?.close ?? NaN;
  const adxVal = adx(candles1h, 14);
  const emaSpreadPct = ema50 === 0 ? 0 : Math.abs(ema20 - ema50) / ema50;

  let trend: TrendResult["trend"];
  if (!Number.isFinite(adxVal) || adxVal < 15 || emaSpreadPct < 0.001) trend = "neutral";
  else if (price > ema20 && ema20 > ema50 && adxVal > 20) trend = "bullish";
  else if (price < ema20 && ema20 < ema50 && adxVal > 20) trend = "bearish";
  else trend = "neutral";

  return {
    trend,
    confidence: adxVal > 25 ? 70 : adxVal > 15 ? 55 : 40,
    source: "ema_adx_fallback",
  };
}

// ── OpenRouter call (owl-alpha model) ─────────────────────────────────────────
async function callOpenRouter(
  apiKey: string,
  symbol: string,
  candles1h: Candle[],
  ema20: number,
  ema50: number,
): Promise<TrendResult> {
  const recent = candles1h.slice(-20).map((c) => ({
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    v: Math.round(c.volume),
  }));
  const price = candles1h.at(-1)?.close ?? 0;

  const prompt = `You are a crypto market-structure classifier. Given the last 20 1H candles for ${symbol}, classify the 1H momentum direction.
Current price: ${price}
EMA20: ${ema20.toFixed(4)}  EMA50: ${ema50.toFixed(4)}
Candles (OHLCV, oldest first): ${JSON.stringify(recent)}

Decide structure (HH/HL = bullish, LH/LL = bearish, otherwise neutral).

Return ONLY valid JSON.
Do not wrap in markdown.
Do not explain.
Do not use code fences.

{"trend":"bullish|bearish|neutral","confidence":0-100,"reasoning":"one short sentence","key_levels":{"support":number,"resistance":number}}`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/purnamasari/tradeway",
      "X-Title": "Tradeway Signal Bot",
    },
    body: JSON.stringify({
      model: "openrouter/owl-alpha",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 256,
    }),
  });

  if (!res.ok) {
    throw new Error(`OpenRouter HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content ?? "";
  const jsonText = extractJsonText(raw);
  const parsed = JSON.parse(jsonText) as {
    trend: TrendResult["trend"];
    confidence: number;
    reasoning?: string;
    key_levels?: { support: number; resistance: number };
  };

  const validTrends = new Set(["bullish", "bearish", "neutral"]);
  if (!validTrends.has(parsed.trend)) {
    throw new Error(`Invalid trend value: "${parsed.trend}"`);
  }

  return {
    trend: parsed.trend,
    confidence: Math.max(0, Math.min(100, parsed.confidence ?? 50)),
    source: "openrouter_owl",
    reasoning: parsed.reasoning,
    keyLevels: parsed.key_levels,
  };
}

// ── Extract JSON from potentially messy model output ──────────────────────────
function extractJsonText(raw: string): string {
  const trimmed = raw.trim();

  // 1. Already clean JSON
  if (trimmed.startsWith("{")) {
    return trimmed;
  }

  // 2. Markdown-fenced JSON: ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  if (fenceMatch?.[1]?.trim().startsWith("{")) {
    return fenceMatch[1].trim();
  }

  // 3. JSON embedded in prose — find the first { and match to its closing }
  const start = trimmed.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === "{") depth++;
      else if (trimmed[i] === "}") depth--;
      if (depth === 0) {
        return trimmed.slice(start, i + 1);
      }
    }
    return trimmed.slice(start);
  }

  throw new Error(`No JSON object found in model response: ${trimmed.slice(0, 80)}…`);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms),
    ),
  ]);
}
