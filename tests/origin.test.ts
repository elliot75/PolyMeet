import { describe, expect, it } from 'vitest';
import { isAllowedOrigin } from '../src/server/origin';
describe('local proxy origin rules', () => {
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
});
