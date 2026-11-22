import type { Context } from 'hono';
import type { ProviderId } from '../shared/types';
import { isLocalRequest } from './origin';

export function requestHost(c: Context): string {
  return c.req.header('host') ?? new URL(c.req.url).host;
}

export function serverProviderKey(
  provider: ProviderId,
  host: string | undefined,
  forwardedHost: string | undefined,
): string | undefined {
  if (!isLocalRequest(host, forwardedHost)) return;
  return (
    (provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY)?.trim() ||
    undefined
  );
}

export function providerKey(c: Context, provider: ProviderId): string | undefined {
  const fromHeader = c.req
    .header(provider === 'openai' ? 'x-openai-api-key' : 'x-gemini-api-key')
    ?.trim();
  return (
    fromHeader || serverProviderKey(provider, requestHost(c), c.req.header('x-forwarded-host'))
  );
}
export function isProvider(value: unknown): value is ProviderId {
  return value === 'openai' || value === 'gemini';
}
