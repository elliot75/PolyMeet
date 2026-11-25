export const MAX_SPEAKER_LABEL_LENGTH = 100;

export type ProviderId = 'openai' | 'gemini';
export type AudioTrackRole = 'mic' | 'system' | 'mixed' | 'upload';
export type MinutesAction = 'polish' | 'translate_and_polish';
export type MinutesStyle = 'standard' | 'action_items' | 'detailed';
export interface FileTranscriptSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
  speaker?: string;
}
export interface TranscriptSegment {
  id: string;
  meetingId: string;
  recordingId?: string;
  track: AudioTrackRole;
  speakerLabel: string;
  speakerGroup?: string;
  startedAtMs: number;
  timeIsChunkStart?: boolean;
  endedAtMs?: number;
  text: string;
  translation?: string;
  translationIsFinal?: boolean;
  isFinal: boolean;
}
export interface MinutesRecord {
  id: string;
  meetingId: string;
  createdAt: number;
  action: MinutesAction;
  targetLanguage: string;
  style: MinutesStyle;
  markdownContent: string;
}

export type UserRole = 'admin' | 'user';
export type KeySource = 'server_env' | 'byok';
export type UsageOperation = 'live_stt' | 'file_stt' | 'translation' | 'minutes';
export type UsageSessionKind = 'recording' | 'file_transcription' | 'minutes' | 'translation';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  allowServerKeys: boolean;
  active: boolean;
  createdAt: number;
}

export interface ModelPricing {
  provider: ProviderId;
  model: string;
  inputPer1M: number;
  audioInputPer1M: number;
  cachedInputPer1M: number;
  outputPer1M: number;
  perMinute: number;
  updatedAt?: number;
}

export interface CurrencySettings {
  currencyCode: string;
  exchangeRate: number;
}

export type UsageDatePreset = 'today' | 'week' | 'month' | 'last_month' | 'all';
export type UsageTimeInterval = [start: number, end: number];

export interface UsageCalendar {
  timeZone: string;
  refreshInMs: number;
  ranges: Record<UsageDatePreset, { from: string; to: string }>;
}

export interface UnsettledUsage {
  id: string;
  username: string;
  meetingTitle: string;
  startedAt: number;
  provider: ProviderId;
  model: string;
  providerReference: string | null;
  operation: UsageOperation;
  keySource: KeySource;
  pendingReconciliation: boolean;
  pricingMissing: boolean;
  textInputTokens: number;
  audioInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface UsageResolution {
  costUsd: number;
  note: string;
  tokens?: Pick<
    UnsettledUsage,
    'textInputTokens' | 'audioInputTokens' | 'cachedInputTokens' | 'outputTokens'
  >;
}

export interface UsageMetric {
  id: string;
  userId: string;
  meetingId: string;
  meetingTitle: string;
  usageSessionId?: string;
  operation: UsageOperation;
  provider: ProviderId;
  model: string;
  keySource: KeySource;
  usageDate: string;
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
  audioSeconds: number;
  textInputTokens: number;
  audioInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  estimated: boolean;
  pricingMissing?: boolean;
  pendingReconciliation?: boolean;
}

export interface ModelUsageRow {
  operation: UsageOperation;
  provider: ProviderId;
  model: string;
  keySource: KeySource;
  calls: number;
  durationSeconds: number;
  audioSeconds: number;
  textInputTokens: number;
  audioInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  estimated: boolean;
  pricingMissing: boolean;
  pendingCalls: number;
}

export interface UsageSessionSummary {
  usageSessionId?: string;
  meetingId: string;
  meetingTitle: string;
  kind?: UsageSessionKind;
  usageDate: string;
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
  audioSeconds: number;
  textInputTokens: number;
  audioInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  keySources: KeySource[];
  models: ModelUsageRow[];
  pendingCalls: number;
}

export interface DailyMeetingUsage {
  usageDate: string;
  userId: string;
  username: string;
  displayName: string;
  meetingId: string;
  meetingTitle: string;
  durationSeconds: number;
  audioSeconds: number;
  textInputTokens: number;
  audioInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  keySources: KeySource[];
  models: ModelUsageRow[];
  pendingCalls: number;
}

export interface AccountUsageSummary {
  userId: string;
  username: string;
  displayName: string;
  allowServerKeys: boolean;
  active: boolean;
  meetingCount: number;
  durationSeconds: number;
  audioSeconds: number;
  textInputTokens: number;
  audioInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  pendingCalls: number;
}

export interface UsageReportResponse {
  currencyCode: string;
  exchangeRate: number;
  totals: {
    meetingCount: number;
    durationSeconds: number;
    audioSeconds: number;
    textInputTokens: number;
    audioInputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
    pendingCalls: number;
  };
  accounts: AccountUsageSummary[];
  dailyMeetings: DailyMeetingUsage[];
}
