import type {
  CurrencySettings,
  KeySource,
  ModelPricing,
  ProviderId,
  UsageOperation,
} from './types';

export const DEFAULT_MODEL_PRICING: readonly ModelPricing[] = [
  // OpenAI transcription & realtime
  {
    provider: 'openai',
    model: 'gpt-live-transcribe',
    inputPer1M: 0,
    audioInputPer1M: 0,
    cachedInputPer1M: 0,
    outputPer1M: 0,
    perMinute: 0.017,
  },
  {
    provider: 'openai',
    model: 'gpt-transcribe',
    inputPer1M: 0,
    audioInputPer1M: 0,
    cachedInputPer1M: 0,
    outputPer1M: 0,
    perMinute: 0.0045,
  },
  {
    provider: 'openai',
    model: 'gpt-4o-transcribe',
    inputPer1M: 2.5,
    audioInputPer1M: 6,
    cachedInputPer1M: 0,
    outputPer1M: 10,
    perMinute: 0.006,
  },
  {
    provider: 'openai',
    model: 'gpt-4o-transcribe-diarize',
    inputPer1M: 2.5,
    audioInputPer1M: 6,
    cachedInputPer1M: 0,
    outputPer1M: 10,
    perMinute: 0.006,
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini-transcribe',
    inputPer1M: 1.25,
    audioInputPer1M: 3,
    cachedInputPer1M: 0,
    outputPer1M: 5,
    perMinute: 0.003,
  },
  {
    provider: 'openai',
    model: 'whisper-1',
    inputPer1M: 0,
    audioInputPer1M: 0,
    cachedInputPer1M: 0,
    outputPer1M: 0,
    perMinute: 0.006,
  },
  // OpenAI text / reasoning
  {
    provider: 'openai',
    model: 'gpt-5',
    inputPer1M: 1.25,
    audioInputPer1M: 0,
    cachedInputPer1M: 0.125,
    outputPer1M: 10,
    perMinute: 0,
  },
  {
    provider: 'openai',
    model: 'gpt-5-mini',
    inputPer1M: 0.25,
    audioInputPer1M: 0,
    cachedInputPer1M: 0.025,
    outputPer1M: 2,
    perMinute: 0,
  },
  {
    provider: 'openai',
    model: 'gpt-5-nano',
    inputPer1M: 0.05,
    audioInputPer1M: 0,
    cachedInputPer1M: 0.005,
    outputPer1M: 0.4,
    perMinute: 0,
  },
  {
    provider: 'openai',
    model: 'gpt-4o',
    inputPer1M: 2.5,
    audioInputPer1M: 0,
    cachedInputPer1M: 1.25,
    outputPer1M: 10,
    perMinute: 0,
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    inputPer1M: 0.15,
    audioInputPer1M: 0,
    cachedInputPer1M: 0.075,
    outputPer1M: 0.6,
    perMinute: 0,
  },
  {
    provider: 'openai',
    model: 'gpt-4.1',
    inputPer1M: 2,
    audioInputPer1M: 0,
    cachedInputPer1M: 0.5,
    outputPer1M: 8,
    perMinute: 0,
  },
  {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    inputPer1M: 0.4,
    audioInputPer1M: 0,
    cachedInputPer1M: 0.1,
    outputPer1M: 1.6,
    perMinute: 0,
  },
  // Google Gemini
  {
    provider: 'gemini',
    model: 'gemini-3.5-transcribe-live',
    inputPer1M: 0.5,
    audioInputPer1M: 3.5,
    cachedInputPer1M: 0.125,
    outputPer1M: 21,
    perMinute: 0.009,
  },
  {
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    inputPer1M: 0.75,
    audioInputPer1M: 0.75,
    cachedInputPer1M: 0.075,
    outputPer1M: 3.75,
    perMinute: 0,
  },
  {
    provider: 'gemini',
    model: 'gemini-3.5-flash-lite',
    inputPer1M: 0.3,
    audioInputPer1M: 0.3,
    cachedInputPer1M: 0.075,
    outputPer1M: 2.5,
    perMinute: 0,
  },
  {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    inputPer1M: 0.3,
    audioInputPer1M: 1.0,
    cachedInputPer1M: 0.075,
    outputPer1M: 2.5,
    perMinute: 0,
  },
  {
    provider: 'gemini',
    model: 'gemini-2.5-flash-lite',
    inputPer1M: 0.1,
    audioInputPer1M: 0.3,
    cachedInputPer1M: 0.025,
    outputPer1M: 0.4,
    perMinute: 0,
  },
  {
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    inputPer1M: 1.25,
    audioInputPer1M: 1.25,
    cachedInputPer1M: 0.3125,
    outputPer1M: 10,
    perMinute: 0,
  },
  {
    provider: 'gemini',
    model: 'gemini-2.0-flash',
    inputPer1M: 0.1,
    audioInputPer1M: 0.7,
    cachedInputPer1M: 0.025,
    outputPer1M: 0.4,
    perMinute: 0,
  },
];

// Google publishes the standard-rate transition at the start of 2027.
export function builtinPricingAt(row: ModelPricing, timestamp: number): ModelPricing {
  if (
    row.provider !== 'gemini' ||
    row.model !== 'gemini-3.8-flash' ||
    timestamp < Date.UTC(2027, 0, 1)
  ) {
    return row;
  }
  return {
    ...row,
    inputPer1M: 1.5,
    audioInputPer1M: 1.5,
    cachedInputPer1M: 0.15,
    outputPer1M: 7.5,
  };
}

export function normalizeModelKey(model: string): string {
  return model
    .trim()
    .replace(/^models\//, '')
    .replace(/(?:-latest|-\d{4}-\d{2}-\d{2}|-\d{3})$/, '');
}

export function findModelPricing(
  table: readonly ModelPricing[],
  provider: ProviderId,
  model: string,
): ModelPricing | undefined {
  const clean = model.trim().replace(/^models\//, '');
  const exact = table.find((row) => row.provider === provider && row.model === clean);
  if (exact) return exact;
  const normalized = normalizeModelKey(clean);
  return table.find(
    (row) => row.provider === provider && normalizeModelKey(row.model) === normalized,
  );
}

export function calculateUsageCost(
  pricing: ModelPricing | undefined,
  usage: {
    textInputTokens: number;
    audioInputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    audioSeconds: number;
    operation: UsageOperation;
  },
): { costUsd: number; pricingMissing: boolean } {
  if (!pricing) return { costUsd: 0, pricingMissing: true };

  const totalInputTokens = usage.textInputTokens + usage.audioInputTokens;
  const hasTokenCounts = totalInputTokens > 0 || usage.outputTokens > 0;
  const hasTokenRates =
    pricing.inputPer1M > 0 || pricing.audioInputPer1M > 0 || pricing.outputPer1M > 0;

  if (hasTokenCounts && hasTokenRates) {
    const effectiveAudioRate =
      pricing.audioInputPer1M > 0 ? pricing.audioInputPer1M : pricing.inputPer1M;
    const effectiveCachedRate =
      pricing.cachedInputPer1M > 0 ? pricing.cachedInputPer1M : pricing.inputPer1M;
    const cached = Math.max(0, Math.min(usage.cachedInputTokens, totalInputTokens));
    const cachedText = Math.min(cached, usage.textInputTokens);
    const cachedAudio = Math.max(0, cached - cachedText);
    const nonCachedText = Math.max(0, usage.textInputTokens - cachedText);
    const nonCachedAudio = Math.max(0, usage.audioInputTokens - cachedAudio);

    const costUsd =
      (nonCachedText * pricing.inputPer1M +
        nonCachedAudio * effectiveAudioRate +
        (cachedText + cachedAudio) * effectiveCachedRate +
        usage.outputTokens * pricing.outputPer1M) /
      1_000_000;
    return { costUsd, pricingMissing: false };
  }

  if (pricing.perMinute > 0 && usage.audioSeconds > 0) {
    return { costUsd: (usage.audioSeconds / 60) * pricing.perMinute, pricingMissing: false };
  }

  return { costUsd: 0, pricingMissing: false };
}

export function localDateString(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.0000';
  if (usd >= 1) return `$${usd.toFixed(4)}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.00')}`;
}

export function formatConvertedCurrency(
  usd: number,
  currency: CurrencySettings,
  locale = 'zh-TW',
): string | null {
  const code = currency.currencyCode.trim().toUpperCase();
  if (!code || !Number.isFinite(currency.exchangeRate) || currency.exchangeRate <= 0) {
    return null;
  }
  const value = usd * currency.exchangeRate;
  return `${code} ${value.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function usageDurationParts(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    remainder: total % 60,
  };
}

export function formatUsageDuration(seconds: number): string {
  const { hours, minutes: mins, remainder: secs } = usageDurationParts(seconds);
  if (hours > 0) {
    return `${hours} 小時 ${String(mins).padStart(2, '0')} 分 ${String(secs).padStart(2, '0')} 秒`;
  }
  if (mins > 0) {
    return `${mins} 分 ${String(secs).padStart(2, '0')} 秒`;
  }
  return `${secs} 秒`;
}

export function formatTokens(n: number, locale = 'zh-TW'): string {
  return Math.max(0, Math.round(n)).toLocaleString(locale);
}

export function operationLabel(op: UsageOperation): string {
  switch (op) {
    case 'live_stt':
      return '即時轉錄';
    case 'file_stt':
      return '音檔轉錄';
    case 'translation':
      return '雙語翻譯';
    case 'minutes':
      return 'AI 會議紀錄';
  }
}

export function keySourceLabel(src: KeySource): string {
  return src === 'server_env' ? '系統 .env 金鑰' : '個人 BYOK 金鑰';
}
