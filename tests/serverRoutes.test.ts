import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/server/app';
import { providerKey } from '../src/server/config';

describe('server routes', () => {
  const original = process.env.OPENAI_API_KEY;
  afterEach(() => {
    vi.unstubAllEnvs();
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  });
  it('reports key availability without revealing the key', async () => {
    process.env.OPENAI_API_KEY = 'server-secret';
    const response = await app.request('/api/health');
    const text = await response.text();
    expect(text).toContain('"openai":true');
    expect(text).not.toContain('server-secret');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('prefers a supplied key to the server fallback', () => {
    process.env.OPENAI_API_KEY = 'server-secret';
    const context = { req: { header: () => 'browser-secret' } } as unknown as Parameters<
      typeof providerKey
    >[0];
    expect(providerKey(context, 'openai')).toBe('browser-secret');
  });
  it('serves configured remote origins without making fallback keys available', async () => {
    vi.stubEnv('POLYMEET_HTTPS_ORIGINS', 'https://meet.example.ts.net');
    process.env.OPENAI_API_KEY = 'server-secret';
    const headers = { Host: 'meet.example.ts.net', Origin: 'https://meet.example.ts.net' };
    const health = await app.request('/api/health', { headers });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ serverKeys: { openai: false } });
    const models = await app.request('/api/models?provider=openai', { headers });
    expect(models.status).toBe(401);
    const forwarded = await app.request('/api/models?provider=openai', {
      headers: { Host: 'localhost:3001', 'X-Forwarded-Host': 'localhost:3001' },
    });
    expect(forwarded.status).toBe(401);
  });
  it('rejects missing credentials and external origins', async () => {
    delete process.env.OPENAI_API_KEY;
    const response = await app.request('/api/minutes/stream', {
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
