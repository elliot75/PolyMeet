import type { ProviderId } from './types';
export type ModelCapability = 'live' | 'file' | 'translation' | 'minutes';
export interface ModelOption {
  id: string;
  capabilities: readonly ModelCapability[];
}
export const gpt6LunaModel = 'gpt-6-luna';
export const lunaReasoningEfforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type LunaReasoningEffort = (typeof lunaReasoningEfforts)[number];

const MANUAL_COMMIT_OPENAI_MODELS = new Set([
  'gpt-live-transcribe',
  'gpt-transcribe',
  'gpt-realtime-whisper',
]);

export function usesManualCommit(provider: ProviderId, model: string): boolean {
  return provider === 'openai' && MANUAL_COMMIT_OPENAI_MODELS.has(model);
}
export const defaultModels = {
  openai: {
    live: 'gpt-live-transcribe',
    file: 'gpt-transcribe',
    translation: 'gpt-5-mini',
    minutes: 'gpt-5-mini',
  },
  gemini: {
    live: 'gemini-3.5-transcribe-live',
    file: 'gemini-3.8-flash',
    translation: 'gemini-3.5-flash-lite',
    minutes: 'gemini-3.8-flash',
  },
} as const satisfies Record<ProviderId, Record<ModelCapability, string>>;
export const suggestedModels: Record<ProviderId, readonly ModelOption[]> = {
  openai: [
    { id: 'gpt-live-transcribe', capabilities: ['live'] },
    { id: 'gpt-transcribe', capabilities: ['file'] },
    { id: 'gpt-4o-transcribe', capabilities: ['live', 'file'] },
    { id: 'gpt-4o-mini-transcribe', capabilities: ['live', 'file'] },
    { id: 'whisper-1', capabilities: ['file'] },
    { id: 'gpt-4o-transcribe-diarize', capabilities: ['file'] },
    { id: gpt6LunaModel, capabilities: ['translation', 'minutes'] },
    { id: 'gpt-5-mini', capabilities: ['translation', 'minutes'] },
    { id: 'gpt-5', capabilities: ['translation', 'minutes'] },
  ],
  gemini: [
    { id: 'gemini-3.5-transcribe-live', capabilities: ['live'] },
    { id: 'gemini-3.8-flash', capabilities: ['file', 'translation', 'minutes'] },
    { id: 'gemini-3.5-flash-lite', capabilities: ['file', 'translation', 'minutes'] },
  ],
};
