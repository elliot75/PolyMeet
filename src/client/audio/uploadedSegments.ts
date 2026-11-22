import type { FileTranscriptSegment, TranscriptSegment } from '../../shared/types';

export interface FileTranscriptionResult {
  segments?: FileTranscriptSegment[];
  text?: string;
  cleanupWarning?: boolean;
}

export function uploadedSegments(
  result: FileTranscriptionResult,
  recording: { id: string; meetingId: string },
  part: { index: number; total: number; offsetMs: number },
): TranscriptSegment[] {
  const timed = Array.isArray(result.segments) ? result.segments : undefined;
  const text = result.text?.trim();
  const items: (Omit<FileTranscriptSegment, 'endSeconds'> & { endSeconds?: number })[] =
    timed ?? (text ? [{ text, startSeconds: 0 }] : []);
  // A provider's speaker labels only identify people within this one response.
  const speakerGroup = items.some((item) => item.speaker) ? crypto.randomUUID() : undefined;
  return items.map((item) => ({
    id: crypto.randomUUID(),
    meetingId: recording.meetingId,
    recordingId: recording.id,
    track: 'upload',
    ...(item.speaker && { speakerGroup }),
    // Independent requests can assign the same anonymous label to different people.
    speakerLabel: item.speaker
      ? part.total > 1
        ? `${item.speaker}（第 ${part.index} 部分）`
        : item.speaker
      : '音檔',
    startedAtMs: part.offsetMs + item.startSeconds * 1000,
    timeIsChunkStart: !timed,
    endedAtMs: item.endSeconds === undefined ? undefined : part.offsetMs + item.endSeconds * 1000,
    text: item.text,
    isFinal: true,
  }));
}
