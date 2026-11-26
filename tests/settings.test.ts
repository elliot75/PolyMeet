import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaults,
  loadSettings,
  saveSettings,
  setSettingsNamespace,
} from '../src/client/services/settings';
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
    setSettingsNamespace(null);
  });
  it('uses the new model configuration for an account without saved settings', () => {
    setSettingsNamespace('other-account');
    saveSettings({ ...defaults, liveProvider: 'gemini', openaiTranslationReasoningEffort: 'high' });
    setSettingsNamespace('new-account');

    expect(loadSettings()).toMatchObject({
      liveProvider: 'openai',
      openaiLiveModel: 'gpt-live-transcribe',
      sttProvider: 'openai',
      openaiSttModel: 'gpt-transcribe',
      translationProvider: 'openai',
      openaiTranslationModel: 'gpt-6-luna',
      openaiTranslationReasoningEffort: 'none',
      provider: 'openai',
      openaiModel: 'gpt-6-luna',
    });
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
  it('uses the new reasoning default for older settings missing that field', () => {
    localStorage.setItem(
      'polymeet-settings',
      JSON.stringify({
        openaiLiveModel: 'gpt-4o-transcribe',
        openaiTranslationModel: 'gpt-5-mini',
      }),
    );
    expect(loadSettings()).toMatchObject({
      openaiLiveModel: 'gpt-4o-transcribe',
      openaiTranslationModel: 'gpt-5-mini',
      openaiTranslationReasoningEffort: 'none',
    });
  });
  it.each(['', 'low'] as const)('retains the saved Luna reasoning choice %j', (effort) => {
    saveSettings({ ...defaults, openaiTranslationReasoningEffort: effort });
    sessionStorage.clear();
    expect(loadSettings().openaiTranslationReasoningEffort).toBe(effort);
  });
});
