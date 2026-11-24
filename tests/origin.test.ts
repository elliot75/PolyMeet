import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAllowedOrigin } from '../src/server/origin';
describe('proxy origin rules', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('accepts the local application and development origins', () => {
    expect(isAllowedOrigin('127.0.0.1:3001', 'http://127.0.0.1:3001')).toBe(true);
    expect(isAllowedOrigin('127.0.0.1:3001', 'http://127.0.0.1:5173')).toBe(true);
    expect(isAllowedOrigin('localhost:3001', undefined)).toBe(true);
  });
  it('rejects attacker-controlled hosts and malformed or external origins', () => {
    expect(isAllowedOrigin('attacker.invalid:3001', 'http://attacker.invalid:3001')).toBe(false);
    expect(isAllowedOrigin('attacker.invalid:3001', undefined)).toBe(false);
    expect(isAllowedOrigin('127.0.0.1:3001', 'https://attacker.invalid')).toBe(false);
    expect(isAllowedOrigin('attacker@localhost:3001', 'http://localhost:3001')).toBe(false);
    expect(isAllowedOrigin('localhost:3001/path', 'http://localhost:3001')).toBe(false);
  });
  it('allows only the configured HTTPS origin for each remote host', () => {
    const lan = 'https://192.168.1.10:8443';
    const tailnet = 'https://meet.example.ts.net';
    expect(isAllowedOrigin('meet.example.ts.net', tailnet)).toBe(false);
    vi.stubEnv('POLYMEET_HTTPS_ORIGINS', `${lan}, ${tailnet}`);
    expect(isAllowedOrigin('192.168.1.10:8443', lan)).toBe(true);
    expect(isAllowedOrigin('meet.example.ts.net:443', tailnet)).toBe(true);
    expect(isAllowedOrigin('meet.example.ts.net', undefined)).toBe(true);
    expect(isAllowedOrigin('meet.example.ts.net', lan)).toBe(false);
    expect(isAllowedOrigin('meet.example.ts.net', 'http://meet.example.ts.net')).toBe(false);
    expect(isAllowedOrigin('192.168.1.10:8444', undefined)).toBe(false);
    expect(isAllowedOrigin('localhost:3001', tailnet)).toBe(false);

    // When reverse proxy strips port from Host header but browser sends port in Origin
    vi.stubEnv(
      'POLYMEET_HTTPS_ORIGINS',
      'https://polymeet.example.com:8082, https://polymeet.example.com',
    );
    expect(isAllowedOrigin('polymeet.example.com', 'https://polymeet.example.com:8082')).toBe(true);
    expect(isAllowedOrigin('polymeet.example.com', 'https://polymeet.example.com')).toBe(true);
    expect(isAllowedOrigin('polymeet.example.com', undefined)).toBe(true);
    expect(isAllowedOrigin('polymeet.example.com', 'https://other.example.com:8082')).toBe(false);
  });
});
