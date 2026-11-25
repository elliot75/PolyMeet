import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/server/app';
import { createSession, createUser, SESSION_COOKIE_NAME } from '../src/server/auth';
import { resolveProviderKey } from '../src/server/config';
import { resetDbForTesting } from '../src/server/db';

describe('server routes', () => {
  const original = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    resetDbForTesting(':memory:');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  });

  it('hides server key availability when unauthenticated and reports it to authorized users without leaking keys', async () => {
    process.env.OPENAI_API_KEY = 'server-secret';
    const anonHealth = await app.request('/api/health');
    expect(anonHealth.status).toBe(200);
    expect(await anonHealth.json()).toMatchObject({
      status: 'ok',
      authenticated: false,
      needsSetup: true,
      serverKeys: { openai: false, gemini: false },
    });

    const user = createUser({
      username: 'alice',
      displayName: 'Alice',
      password: 'password123',
      role: 'admin',
      allowServerKeys: true,
    });
    const { token } = createSession(user.id);
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;

    const response = await app.request('/api/health', { headers: { Cookie: cookie } });
    const text = await response.text();
    expect(text).toContain('"openai":true');
    expect(text).toContain('"authenticated":true');
    expect(text).not.toContain('server-secret');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('prefers a supplied BYOK key to the server fallback and respects allowServerKeys', () => {
    process.env.OPENAI_API_KEY = 'server-secret';
    const allowedUser = {
      id: 'u1',
      username: 'alice',
      displayName: 'Alice',
      role: 'user' as const,
      allowServerKeys: true,
      active: true,
      createdAt: 1,
    };
    const restrictedUser = { ...allowedUser, allowServerKeys: false };

    const withHeader = { req: { header: () => 'browser-secret' } } as unknown as Parameters<
      typeof resolveProviderKey
    >[0];
    expect(resolveProviderKey(withHeader, 'openai', allowedUser)).toEqual({
      key: 'browser-secret',
      keySource: 'byok',
    });
    expect(resolveProviderKey(withHeader, 'openai', restrictedUser)).toEqual({
      key: 'browser-secret',
      keySource: 'byok',
    });

    const withoutHeader = { req: { header: () => undefined } } as unknown as Parameters<
      typeof resolveProviderKey
    >[0];
    expect(resolveProviderKey(withoutHeader, 'openai', allowedUser)).toEqual({
      key: 'server-secret',
      keySource: 'server_env',
    });
    expect(resolveProviderKey(withoutHeader, 'openai', restrictedUser)).toBeUndefined();
  });

  it('allows authenticated users to use server keys over configured remote HTTPS origins while blocking unauthenticated calls', async () => {
    vi.stubEnv('POLYMEET_HTTPS_ORIGINS', 'https://meet.example.ts.net');
    process.env.OPENAI_API_KEY = 'server-secret';
    const baseHeaders = { Host: 'meet.example.ts.net', Origin: 'https://meet.example.ts.net' };

    const anonModels = await app.request('/api/models?provider=openai', { headers: baseHeaders });
    expect(anonModels.status).toBe(401);
    expect(await anonModels.json()).toEqual({ error: 'unauthenticated' });

    const restricted = createUser({
      username: 'bob',
      displayName: 'Bob',
      password: 'password123',
      role: 'user',
      allowServerKeys: false,
    });
    const { token } = createSession(restricted.id);
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;

    const health = await app.request('/api/health', {
      headers: { ...baseHeaders, Cookie: cookie },
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      authenticated: true,
      serverKeys: { openai: false },
    });
    const models = await app.request('/api/models?provider=openai', {
      headers: { ...baseHeaders, Cookie: cookie },
    });
    expect(models.status).toBe(401);
    expect(await models.json()).toEqual({ error: 'missing_api_key' });
  });

  it('rejects unauthenticated requests, missing credentials, and external origins', async () => {
    delete process.env.OPENAI_API_KEY;
    const unauth = await app.request('/api/minutes/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        model: 'test',
        text: 'hello',
        targetLanguage: 'English',
        action: 'polish',
        style: 'standard',
      }),
    });
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ error: 'unauthenticated' });

    const user = createUser({
      username: 'alice',
      displayName: 'Alice',
      password: 'password123',
      role: 'user',
      allowServerKeys: true,
    });
    const { token } = createSession(user.id);
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;

    const response = await app.request('/api/minutes/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        provider: 'openai',
        model: 'test',
        text: 'hello',
        targetLanguage: 'English',
        action: 'polish',
        style: 'standard',
      }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'missing_api_key' });

    const forbidden = await app.request('/api/health', {
      headers: { Origin: 'https://example.com' },
    });
    expect(forbidden.status).toBe(403);
    const rebound = await app.request('/api/health', {
      headers: { Host: 'attacker.invalid:3001', Origin: 'http://attacker.invalid:3001' },
    });
    expect(rebound.status).toBe(403);
    const reboundWithoutOrigin = await app.request('/api/health', {
      headers: { Host: 'attacker.invalid:3001' },
    });
    expect(reboundWithoutOrigin.status).toBe(403);
  });
});
