import type { ProviderId } from '../../shared/types';
import { defaultModels } from '../../shared/models';
export interface Settings {
  provider: ProviderId;
  openaiModel: string;
  geminiModel: string;
  openaiKey: string;
  geminiKey: string;
  sttProvider: ProviderId;
  openaiSttModel: string;
  geminiSttModel: string;
  liveProvider: ProviderId;
  openaiLiveModel: string;
  geminiLiveModel: string;
  translationProvider: ProviderId;
  openaiTranslationModel: string;
  geminiTranslationModel: string;
  rememberKeys: boolean;
}
export const defaults: Settings = {
  provider: 'openai',
  openaiModel: defaultModels.openai.minutes,
  geminiModel: defaultModels.gemini.minutes,
  openaiKey: '',
  geminiKey: '',
  sttProvider: 'openai',
  openaiSttModel: defaultModels.openai.file,
  geminiSttModel: defaultModels.gemini.file,
  liveProvider: 'openai',
  openaiLiveModel: defaultModels.openai.live,
  geminiLiveModel: defaultModels.gemini.live,
  translationProvider: 'openai',
  openaiTranslationModel: defaultModels.openai.translation,
  geminiTranslationModel: defaultModels.gemini.translation,
  rememberKeys: false,
};

let currentSettingsKey = 'polymeet-settings';

export function setSettingsNamespace(userId: string | null) {
  currentSettingsKey = userId ? `polymeet-settings:${userId}` : 'polymeet-settings';
}

export function clearSessionSettings() {
  try {
    sessionStorage.removeItem(currentSettingsKey);
  } catch {
    // Ignore storage errors.
  }
}

export function loadSettings(): Settings {
  try {
    return {
      ...defaults,
      ...JSON.parse(localStorage.getItem(currentSettingsKey) || '{}'),
      ...JSON.parse(sessionStorage.getItem(currentSettingsKey) || '{}'),
    };
  } catch {
    return defaults;
  }
}
export function saveSettings(settings: Settings) {
  const persistent = settings.rememberKeys
    ? settings
    : { ...settings, openaiKey: '', geminiKey: '' };
  localStorage.setItem(currentSettingsKey, JSON.stringify(persistent));
  sessionStorage.setItem(currentSettingsKey, JSON.stringify(settings));
}
export function headers(settings: Settings): Record<string, string> {
  const key = settings.provider === 'openai' ? settings.openaiKey : settings.geminiKey;
  return key.trim()
    ? { [settings.provider === 'openai' ? 'x-openai-api-key' : 'x-gemini-api-key']: key.trim() }
    : {};
}
export function model(settings: Settings) {
  return settings.provider === 'openai' ? settings.openaiModel : settings.geminiModel;
}
