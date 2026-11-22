import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyThemePreference, getThemePreference } from '../src/client/services/theme';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  };
}

describe('theme preference', () => {
  let metaContent = 'light dark';

  beforeEach(() => {
    metaContent = 'light dark';
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('document', {
      querySelector: () => ({
        setAttribute: (_name: string, value: string) => {
          metaContent = value;
        },
      }),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('persists explicit themes and removes the stored override when reverting to system', () => {
    expect(getThemePreference()).toBe('system');

    applyThemePreference('dark');
    expect(metaContent).toBe('dark');
    expect(localStorage.getItem('color-scheme')).toBe('dark');
    expect(getThemePreference()).toBe('dark');

    applyThemePreference('light');
    expect(metaContent).toBe('light');
    expect(localStorage.getItem('color-scheme')).toBe('light');
    expect(getThemePreference()).toBe('light');

    applyThemePreference('system');
    expect(metaContent).toBe('light dark');
    expect(localStorage.getItem('color-scheme')).toBeNull();
    expect(getThemePreference()).toBe('system');
  });
});
