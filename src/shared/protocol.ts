import type { AudioTrackRole, ProviderId, UsageMetric } from './types';
export const WORKSPACE_ACCOUNT_HEADER = 'X-PolyMeet-Account';
export const WORKSPACE_SESSION_HEADER = 'X-PolyMeet-Session-State';

export type SttStart = {
  type: 'session.start';
  provider: ProviderId;
  accountId?: string;
  apiKey?: string;
  model: string;
  sampleRate: 16000 | 24000;
  languageHints?: string[];
  track: AudioTrackRole;
  meetingId?: string;
  meetingTitle?: string;
  recordingId?: string;
  usageSessionId?: string;
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
      failed?: true;
      audioEndMs?: number;
    }
  | { type: 'transcript.committed'; segmentId: string }
  | {
      type: 'session.reconnecting';
      reason: string;
      discardedInterims?: string[];
      track?: AudioTrackRole;
    }
  | { type: 'usage.recorded'; usage: UsageMetric }
  | { type: 'error'; code: string; message: string; recoverable: boolean };
