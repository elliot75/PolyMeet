import { describe, expect, it } from 'vitest';
import {
  calculateUsageCost,
  DEFAULT_MODEL_PRICING,
  findModelPricing,
  formatConvertedCurrency,
  formatUsageDuration,
  formatUsd,
  normalizeModelKey,
} from '../src/shared/pricing';

describe('pricing engine and formatting', () => {
  it('matches exact and dated snapshot model names', () => {
    expect(normalizeModelKey('models/gpt-5-mini-2026-01-15')).toBe('gpt-5-mini');
    expect(findModelPricing(DEFAULT_MODEL_PRICING, 'openai', 'gpt-5-mini')?.outputPer1M).toBe(2);
    expect(
      findModelPricing(DEFAULT_MODEL_PRICING, 'openai', 'gpt-5-mini-2026-01-15')?.inputPer1M,
    ).toBe(0.25);
    expect(
      findModelPricing(DEFAULT_MODEL_PRICING, 'gemini', 'models/gemini-3.8-flash')?.outputPer1M,
    ).toBe(3.75);
    expect(
      findModelPricing(DEFAULT_MODEL_PRICING, 'openai', 'unknown-custom-model'),
    ).toBeUndefined();
  });

  it('calculates token costs including cached discount and audio input rates', () => {
    const gpt5Mini = findModelPricing(DEFAULT_MODEL_PRICING, 'openai', 'gpt-5-mini')!;
    const result = calculateUsageCost(gpt5Mini, {
      textInputTokens: 1_000_000,
      audioInputTokens: 0,
      cachedInputTokens: 400_000,
      outputTokens: 500_000,
      audioSeconds: 0,
      operation: 'minutes',
    });
    // 600k * 0.25 + 400k * 0.025 + 500k * 2 = 0.15 + 0.01 + 1.0 = 1.16
    expect(result.pricingMissing).toBe(false);
    expect(result.costUsd).toBeCloseTo(1.16, 6);

    const geminiLive = findModelPricing(
      DEFAULT_MODEL_PRICING,
      'gemini',
      'gemini-3.5-transcribe-live',
    )!;
    const liveCost = calculateUsageCost(geminiLive, {
      textInputTokens: 100_000,
      audioInputTokens: 200_000,
      cachedInputTokens: 0,
      outputTokens: 10_000,
      audioSeconds: 60,
      operation: 'live_stt',
    });
    // 0.1M * 0.5 + 0.2M * 3.5 + 0.01M * 21 = 0.05 + 0.70 + 0.21 = 0.96
    expect(liveCost.costUsd).toBeCloseTo(0.96, 6);
  });

  it('falls back to per-minute audio billing and flags missing pricing', () => {
    const whisper = findModelPricing(DEFAULT_MODEL_PRICING, 'openai', 'whisper-1')!;
    const res = calculateUsageCost(whisper, {
      textInputTokens: 0,
      audioInputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      audioSeconds: 90,
      operation: 'file_stt',
    });
    expect(res.pricingMissing).toBe(false);
    expect(res.costUsd).toBeCloseTo(0.009, 6);

    const missing = calculateUsageCost(undefined, {
      textInputTokens: 100,
      audioInputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 50,
      audioSeconds: 0,
      operation: 'translation',
    });
    expect(missing).toEqual({ costUsd: 0, pricingMissing: true });
  });

  it('formats durations, USD, and optional secondary currencies cleanly', () => {
    expect(formatUsageDuration(45)).toBe('45 秒');
    expect(formatUsageDuration(125)).toBe('2 分 05 秒');
    expect(formatUsageDuration(3665)).toBe('1 小時 01 分 05 秒');
    expect(formatUsd(0)).toBe('$0.0000');
    expect(formatUsd(0.01234)).toBe('$0.0123');
    expect(formatConvertedCurrency(2, { currencyCode: 'TWD', exchangeRate: 32.5 })).toBe(
      'TWD 65.00',
    );
    expect(formatConvertedCurrency(2, { currencyCode: '', exchangeRate: 32.5 })).toBeNull();
  });
});
