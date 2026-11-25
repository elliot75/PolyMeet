import { workspaceFetch } from './workspaceSession';
import { OPENAI_MAX_AUDIO_SECONDS, splitAudio } from '../audio/audioChunker';
import { normalizeAudioMime } from '../audio/audioMime';
import { uploadedSegments, type FileTranscriptionResult } from '../audio/uploadedSegments';
import { getRecordingBlob, saveRecordingSegments, type Recording } from '../db/meetingDb';
import type { TranscriptSegment } from '../../shared/types';
import { headers, type Settings } from './settings';

interface TranscriptionOptions {
  recording: Recording;
  settings: Settings;
  languageHints: string[];
  signal: AbortSignal;
  meetingTitle?: string;
  usageSessionId?: string;
  onPartStart: (index: number, total: number) => void;
  onPartComplete: (index: number, cleanupWarning: boolean) => void;
}

export async function* transcribeAudio(
  file: File,
  {
    recording,
    settings,
    languageHints,
    signal,
    meetingTitle,
    usageSessionId,
    onPartStart,
  }: TranscriptionOptions,
  completedParts = 0,
) {
  signal.throwIfAborted();
  const checkDuration =
    settings.sttProvider === 'openai' &&
    (recording.durationSeconds === undefined ||
      recording.durationSeconds >= OPENAI_MAX_AUDIO_SECONDS);
  for await (const part of splitAudio(file, completedParts, signal, checkDuration)) {
    onPartStart(part.index, part.total);
    const form = new FormData();
    form.set('provider', settings.sttProvider);
    form.set(
      'model',
      settings.sttProvider === 'openai' ? settings.openaiSttModel : settings.geminiSttModel,
    );
    form.set('file', part.file);
    form.set('meetingId', recording.meetingId);
    if (meetingTitle) form.set('meetingTitle', meetingTitle);
    if (usageSessionId) form.set('usageSessionId', usageSessionId);
    const partAudioSeconds = part.durationSeconds ?? recording.durationSeconds;
    if (partAudioSeconds && Number.isFinite(partAudioSeconds) && partAudioSeconds > 0) {
      form.set('audioSeconds', String(partAudioSeconds));
    }
    for (const language of languageHints) form.append('language', language);
    const response = await workspaceFetch('/api/transcribe-file', {
      method: 'POST',
      headers: headers({ ...settings, provider: settings.sttProvider }),
      body: form,
      signal,
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(
        result.cleanupWarning
          ? '轉錄失敗且無法刪除 Google 暫存檔，請至供應商管理介面檢查。'
          : result.error === 'unauthenticated'
            ? '登入階段已過期，請重新登入。'
            : result.error === 'missing_api_key'
              ? '請先在設定中加入轉錄服務金鑰。'
              : result.error === 'auth_failed'
                ? 'API 金鑰驗證失敗或無此模型權限，請檢查設定。'
                : '音檔轉錄失敗，請檢查模型、金鑰及後端服務。',
      );
    }
    const result: FileTranscriptionResult = await response.json();
    signal.throwIfAborted();
    const segments = uploadedSegments(result, recording, part);
    yield { index: part.index, segments, cleanupWarning: Boolean(result.cleanupWarning) };
  }
}

export function recordingFilename(recording: Recording) {
  if (recording.filename) return recording.filename;
  const container = recording.mimeType.split(';')[0].split('/')[1];
  const extensions: Record<string, string> = { mp4: 'm4a', mpeg: 'mp3', 'x-m4a': 'm4a' };
  return `polymeet-${recording.createdAt}.${extensions[container] || container || 'webm'}`;
}

export async function transcribeSavedRecording(
  options: TranscriptionOptions,
  previous?: TranscriptSegment[],
) {
  const { recording, signal, onPartComplete } = options;
  const blob = await getRecordingBlob(recording);
  signal.throwIfAborted();
  if (!blob.size) throw new Error('此錄音沒有可轉錄的音訊片段。');
  const filename = recordingFilename(recording);
  const mimeType = normalizeAudioMime(blob.type || recording.mimeType, filename) || 'audio/webm';
  const file = new File([blob], filename, { type: mimeType });
  const segments: TranscriptSegment[] = [];
  for await (const part of transcribeAudio(file, options)) {
    segments.push(...part.segments);
    onPartComplete(part.index, part.cleanupWarning);
  }
  await saveRecordingSegments(recording, segments, previous, signal);
  return segments;
}
