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
