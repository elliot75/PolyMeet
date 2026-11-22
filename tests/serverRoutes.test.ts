import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../src/server/app';
import { providerKey } from '../src/server/config';

describe('server routes', () => {
  const original = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  });
  it('reports key availability without revealing the key', async () => {
    process.env.OPENAI_API_KEY = 'server-secret';
    const response = await app.request('/api/health');
    const text = await response.text();
    expect(text).toContain('"openai":true');
    expect(text).not.toContain('server-secret');
  });
  it('prefers a supplied key to the server fallback', () => {
    process.env.OPENAI_API_KEY = 'server-secret';
    const context = { req: { header: () => 'browser-secret' } } as unknown as Parameters<
      typeof providerKey
    >[0];
    expect(providerKey(context, 'openai')).toBe('browser-secret');
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
