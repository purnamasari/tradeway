// AI Trend Classifier — enhancement layer, NOT a hard dependency.
// 3-tier: Gemini 2.5 Flash -> Flash-Lite -> EMA/ADX rule fallback.
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
  candles4h: Candle[],
  ema20: number,
  ema50: number,
  deps: Deps,
): Promise<TrendResult> {
  const cacheKey = `trend:${symbol}`;
  const cached = await deps.cache.get(cacheKey);
  if (cached) return JSON.parse(cached) as TrendResult;

  // ── Tiers 1 & 2: Gemini (only if configured) ────────────────────────────────
  if (deps.geminiApiKey) {
    for (const [model, timeoutMs, ttl, source] of [
      ["gemini-2.5-flash", deps.rules.flash_timeout_ms, 1800, "gemini_flash"],
      ["gemini-2.5-flash-lite", deps.rules.flash_lite_timeout_ms, 900, "gemini_flash_lite"],
    ] as const) {
      try {
        const result = await withTimeout(
          callGemini(model, deps.geminiApiKey, symbol, candles4h, ema20, ema50),
          timeoutMs,
        );
        if (result.confidence >= deps.rules.confidence_floor) {
          const final: TrendResult = { ...result, source };
          await deps.cache.setex(cacheKey, ttl, JSON.stringify(final));
          return final;
        }
        logger.warn(`[trend] ${model} low confidence ${result.confidence} for ${symbol}`);
      } catch (err) {
        logger.warn(`[trend] ${model} failed for ${symbol}: ${(err as Error).message}`);
      }
    }
  }

  // ── Tier 3: EMA/ADX rule fallback ───────────────────────────────────────────
  const fallback = emaAdxTrendClassifier(candles4h, ema20, ema50);
  await deps.cache.setex(cacheKey, 600, JSON.stringify(fallback));
  return fallback;
}

export function emaAdxTrendClassifier(
  candles4h: Candle[],
  ema20: number,
  ema50: number,
): TrendResult {
  const price = candles4h.at(-1)?.close ?? NaN;
  const adxVal = adx(candles4h, 14);
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

// ── Gemini call (lazy import so the dep is optional) ──────────────────────────
async function callGemini(
  model: string,
  apiKey: string,
  symbol: string,
  candles4h: Candle[],
  ema20: number,
  ema50: number,
): Promise<TrendResult> {
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(apiKey);
  const m = genAI.getGenerativeModel({
    model,
    generationConfig: { responseMimeType: "application/json", temperature: 0.1, maxOutputTokens: 256 },
  });

  const recent = candles4h.slice(-20).map((c) => ({
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    v: Math.round(c.volume),
  }));
  const price = candles4h.at(-1)?.close ?? 0;

  const prompt = `You are a crypto market-structure classifier. Given the last 20 4H candles for ${symbol}, classify the 4H momentum direction.
Current price: ${price}
EMA20: ${ema20.toFixed(4)}  EMA50: ${ema50.toFixed(4)}
Candles (OHLCV, oldest first): ${JSON.stringify(recent)}

Decide structure (HH/HL = bullish, LH/LL = bearish, otherwise neutral).

Return ONLY valid JSON.
Do not wrap in markdown.
Do not explain.
Do not use code fences.

{"trend":"bullish|bearish|neutral","confidence":0-100,"reasoning":"one short sentence","key_levels":{"support":number,"resistance":number}}`;

  const res = await m.generateContent(prompt);
  const raw = res.response.text();
  const jsonText = extractJsonText(raw);
  const parsed = JSON.parse(jsonText) as {
    trend: TrendResult["trend"];
    confidence: number;
    reasoning?: string;
    key_levels?: { support: number; resistance: number };
  };

  // Validate the trend field
  const validTrends = new Set(["bullish", "bearish", "neutral"]);
  if (!validTrends.has(parsed.trend)) {
    throw new Error(`Invalid trend value: "${parsed.trend}"`);
  }

  return {
    trend: parsed.trend,
    confidence: Math.max(0, Math.min(100, parsed.confidence ?? 50)),
    source: "gemini_flash",
    reasoning: parsed.reasoning,
    keyLevels: parsed.key_levels,
  };
}

// ── Extract JSON from potentially messy Gemini output ─────────────────────────
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
    // Unclosed brace — still try the substring (JSON.parse will throw with a clearer error)
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
