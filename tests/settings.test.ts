import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults, loadSettings, saveSettings } from '../src/client/services/settings';
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
describe('settings persistence', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    vi.stubGlobal('sessionStorage', memoryStorage());
  });
  it('persists model choices but keeps keys in the current session by default', () => {
    saveSettings({ ...defaults, openaiKey: 'test-key', openaiModel: 'custom-model' });
    expect(localStorage.getItem('polymeet-settings')).not.toContain('test-key');
    expect(loadSettings().openaiKey).toBe('test-key');
    sessionStorage.clear();
    expect(loadSettings()).toMatchObject({ openaiKey: '', openaiModel: 'custom-model' });
  });
  it('only retains keys across sessions when explicitly requested, and removes them when disabled', () => {
    saveSettings({ ...defaults, geminiKey: 'test-key', rememberKeys: true });
    sessionStorage.clear();
    expect(loadSettings().geminiKey).toBe('test-key');
    saveSettings({ ...loadSettings(), rememberKeys: false });
    expect(localStorage.getItem('polymeet-settings')).not.toContain('test-key');
  });
});
