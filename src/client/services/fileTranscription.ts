import { splitAudio } from '../audio/audioChunker';
import { getRecordingBlob, saveRecordingSegments, type Recording } from '../db/meetingDb';
import type { TranscriptSegment } from '../../shared/types';
import { headers, type Settings } from './settings';

interface TranscriptionOptions {
  recording: Recording;
  settings: Settings;
  languageHints: string[];
  signal: AbortSignal;
  onPartStart: (index: number, total: number) => void;
  onPartComplete: (index: number, cleanupWarning: boolean) => void;
}

export async function* transcribeAudio(
  file: File,
  { recording, settings, languageHints, signal, onPartStart }: TranscriptionOptions,
  completedParts = 0,
) {
  signal.throwIfAborted();
  for await (const part of splitAudio(file, completedParts, signal)) {
    onPartStart(part.index, part.total);
    const form = new FormData();
    form.set('provider', settings.sttProvider);
    form.set(
      'model',
      settings.sttProvider === 'openai' ? settings.openaiSttModel : settings.geminiSttModel,
    );
    form.set('file', part.file);
    for (const language of languageHints) form.append('language', language);
    const response = await fetch('/api/transcribe-file', {
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
          : result.error === 'missing_api_key'
            ? '請先在設定中加入轉錄服務金鑰。'
            : '音檔轉錄失敗，請檢查模型、金鑰及後端服務。',
      );
    }
    const result = await response.json();
    signal.throwIfAborted();
    const timed = Array.isArray(result.segments);
    const items: { text: string; startSeconds: number; endSeconds?: number }[] = timed
      ? result.segments
      : result.text?.trim()
        ? [{ text: result.text.trim(), startSeconds: 0 }]
        : [];
    const segments: TranscriptSegment[] = items.map((item) => ({
      id: crypto.randomUUID(),
      meetingId: recording.meetingId,
      recordingId: recording.id,
      track: 'upload',
      speakerLabel: '音檔',
      startedAtMs: part.offsetMs + item.startSeconds * 1000,
      timeIsChunkStart: !timed,
      endedAtMs: item.endSeconds === undefined ? undefined : part.offsetMs + item.endSeconds * 1000,
      text: item.text,
      isFinal: true,
    }));
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
  const file = new File([blob], recordingFilename(recording), {
    type: blob.type.replace(/^video\//, 'audio/'),
  });
  const segments: TranscriptSegment[] = [];
  for await (const part of transcribeAudio(file, options)) {
    segments.push(...part.segments);
    onPartComplete(part.index, part.cleanupWarning);
  }
  await saveRecordingSegments(recording, segments, previous, signal);
  return segments;
}
