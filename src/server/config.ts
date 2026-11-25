import type { Context } from 'hono';
import type { AuthUser, KeySource, ProviderId } from '../shared/types';

export interface ResolvedProviderKey {
  key: string;
  keySource: KeySource;
}

export function requestHost(c: Context): string {
  return c.req.header('host') ?? new URL(c.req.url).host;
}

export function envProviderKey(provider: ProviderId): string | undefined {
  return (
    (provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY)?.trim() ||
    undefined
  );
}

export function resolveProviderKey(
  c: Context,
  provider: ProviderId,
  user: AuthUser,
): ResolvedProviderKey | undefined {
  const fromHeader = c.req
    .header(provider === 'openai' ? 'x-openai-api-key' : 'x-gemini-api-key')
    ?.trim();
  if (fromHeader) {
    return { key: fromHeader, keySource: 'byok' };
  }
  if (!user.allowServerKeys) return undefined;
  const fromEnv = envProviderKey(provider);
  return fromEnv ? { key: fromEnv, keySource: 'server_env' } : undefined;
}

export function resolveWsProviderKey(
  provider: ProviderId,
  apiKey: string | undefined,
  user: AuthUser,
): ResolvedProviderKey | undefined {
  const fromClient = apiKey?.trim();
  if (fromClient) {
    return { key: fromClient, keySource: 'byok' };
  }
  if (!user.allowServerKeys) return undefined;
  const fromEnv = envProviderKey(provider);
  return fromEnv ? { key: fromEnv, keySource: 'server_env' } : undefined;
}

export function isProvider(value: unknown): value is ProviderId {
  return value === 'openai' || value === 'gemini';
}
