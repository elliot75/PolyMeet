import type { Context } from 'hono';
import type { ProviderId } from '../shared/types';

export function providerKey(c: Context, provider: ProviderId): string | undefined {
  const fromHeader = c.req
    .header(provider === 'openai' ? 'x-openai-api-key' : 'x-gemini-api-key')
    ?.trim();
  return (
    fromHeader ||
    (provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY)?.trim() ||
    undefined
  );
}
export function isProvider(value: unknown): value is ProviderId {
  return value === 'openai' || value === 'gemini';
}
