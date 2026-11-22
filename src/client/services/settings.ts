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
export function loadSettings(): Settings {
  try {
    return {
      ...defaults,
      ...JSON.parse(localStorage.getItem('polymeet-settings') || '{}'),
      ...JSON.parse(sessionStorage.getItem('polymeet-settings') || '{}'),
    };
  } catch {
    return defaults;
  }
}
export function saveSettings(settings: Settings) {
  const persistent = settings.rememberKeys
    ? settings
    : { ...settings, openaiKey: '', geminiKey: '' };
  localStorage.setItem('polymeet-settings', JSON.stringify(persistent));
  sessionStorage.setItem('polymeet-settings', JSON.stringify(settings));
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
