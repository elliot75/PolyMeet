import type { AudioTrackRole, ProviderId } from './types';
export type SttStart = {
  type: 'session.start';
  provider: ProviderId;
  apiKey?: string;
  model: string;
  sampleRate: 16000 | 24000;
  languageHints?: string[];
  track: AudioTrackRole;
};
export type SttClientMessage =
  | SttStart
  | { type: 'audio.chunk'; pcm16Base64: string }
  | { type: 'audio.commit' }
  | { type: 'audio.end' }
  | { type: 'session.stop' };
export type SttServerEvent =
  | { type: 'session.ready'; provider: ProviderId; model: string }
  | {
      type: 'transcript.interim' | 'transcript.final';
      segmentId: string;
      text: string;
      track: AudioTrackRole;
    }
  | { type: 'transcript.committed'; segmentId: string }
  | {
      type: 'session.reconnecting';
      reason: string;
      discardedInterims?: string[];
      track?: AudioTrackRole;
    }
  | { type: 'error'; code: string; message: string; recoverable: boolean };
