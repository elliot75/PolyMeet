import type { MinutesRecord, TranscriptSegment } from '../../shared/types';

export type MinutesExportFormat = 'md' | 'txt' | 'json';
type SubtitleFormat = 'srt' | 'vtt';
export type TranscriptExportFormat = 'md' | 'txt' | SubtitleFormat;
type RecordingDuration = { id: string; durationSeconds?: number };
export type MinutesExportMetadata = Pick<MinutesRecord, 'action' | 'targetLanguage' | 'style'> &
  Partial<Pick<MinutesRecord, 'id' | 'meetingId' | 'createdAt'>>;

function sanitizeFilename(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadMeetingArchive(blob: Blob, title?: string) {
  const name =
    title === undefined ? 'polymeet-workspace' : sanitizeFilename(title) || 'polymeet-meeting';
  downloadBlob(`${name}.polymeet`, blob);
}

export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function buildMinutesExport(
  format: MinutesExportFormat,
  markdownContent: string,
  metadata: MinutesExportMetadata,
  filenamePrefix?: string,
) {
  const mimeType =
    format === 'md' ? 'text/markdown' : format === 'txt' ? 'text/plain' : 'application/json';
  const content =
    format === 'json' ? JSON.stringify({ ...metadata, markdownContent }, null, 2) : markdownContent;
  const safePrefix = filenamePrefix ? sanitizeFilename(filenamePrefix) : '';
  const filename = safePrefix ? `${safePrefix}-minutes.${format}` : `minutes.${format}`;
  return { filename, mimeType, content };
}

export function downloadMinutes(
  format: MinutesExportFormat,
  markdownContent: string,
  metadata: MinutesExportMetadata,
  filenamePrefix?: string,
) {
  const file = buildMinutesExport(format, markdownContent, metadata, filenamePrefix);
  downloadBlob(file.filename, new Blob([file.content], { type: file.mimeType }));
}

export function formatSubtitleTimestamp(ms: number, format: SubtitleFormat): string {
  const time = Math.max(0, Math.round(ms));
  const hours = Math.floor(time / 3_600_000);
  const minutes = Math.floor(time / 60_000) % 60;
  const seconds = Math.floor(time / 1000) % 60;
  const clock = [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
  return `${clock}${format === 'srt' ? ',' : '.'}${String(time % 1000).padStart(3, '0')}`;
}

function subtitleText(text: string): string {
  return text
    .split(/\r\n?|\n/)
    .map((line) => line.replace(/\0/g, '').trim())
    .filter(Boolean)
    .join('\n');
}

function buildSubtitles(
  format: SubtitleFormat,
  segments: TranscriptSegment[],
  recordings: RecordingDuration[],
): string {
  const groups = new Map<string | undefined, TranscriptSegment[]>();
  for (const segment of segments) {
    const group = groups.get(segment.recordingId);
    if (group) group.push(segment);
    else groups.set(segment.recordingId, [segment]);
  }
  const durations = new Map(recordings.map(({ id, durationSeconds }) => [id, durationSeconds]));
  const cues: string[] = [];
  let offset = 0;
  for (const [recordingId, group] of groups) {
    const sorted = group
      .map((segment) => ({
        start: Math.max(0, Math.round(segment.startedAtMs)),
        end: Math.round(segment.endedAtMs ?? 0),
        speaker: segment.speakerGroup ? subtitleText(segment.speakerLabel).replace(/\n/g, ' ') : '',
        text: subtitleText(segment.text),
        translation: subtitleText(segment.translation ?? ''),
      }))
      .filter((cue) => Number.isFinite(cue.start) && (cue.text || cue.translation))
      .sort((a, b) => a.start - b.start);
    let groupEnd = 0;
    let next = 0;
    for (const cue of sorted) {
      while (next < sorted.length && sorted[next].start <= cue.start) next++;
      const estimatedDuration = Math.min(
        6000,
        Math.max(1000, Array.from(cue.text || cue.translation).length * 70),
      );
      const end =
        Number.isFinite(cue.end) && cue.end > cue.start
          ? cue.end
          : Math.min(cue.start + estimatedDuration, sorted[next]?.start ?? Infinity);
      const timing = `${formatSubtitleTimestamp(offset + cue.start, format)} --> ${formatSubtitleTimestamp(offset + end, format)}`;
      const lines = [cue.text, cue.translation].filter(Boolean).join('\n');
      const content = (cue.speaker ? `${cue.speaker}：${lines}` : lines)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      cues.push(
        format === 'srt' ? `${cues.length + 1}\n${timing}\n${content}` : `${timing}\n${content}`,
      );
      groupEnd = Math.max(groupEnd, end);
    }
    const duration = recordingId ? durations.get(recordingId) : undefined;
    offset += Math.max(groupEnd, Math.round((duration ?? 0) * 1000));
  }
  const header = format === 'vtt' ? 'WEBVTT\n\n' : '';
  return header + (cues.length ? `${cues.join('\n\n')}\n` : '');
}

export function buildTranscriptExport(
  format: TranscriptExportFormat,
  segments: TranscriptSegment[],
  title?: string,
  recordings: RecordingDuration[] = [],
) {
  const safeTitle = title ? sanitizeFilename(title) : '';
  const filename = safeTitle ? `${safeTitle}-transcript.${format}` : `transcript.${format}`;
  if (format === 'srt' || format === 'vtt') {
    return {
      filename,
      mimeType: format === 'vtt' ? 'text/vtt' : 'application/x-subrip',
      content: buildSubtitles(format, segments, recordings),
    };
  }
  const heading = title?.trim() || 'PolyMeet 逐字稿';
  const lines = segments.map((segment) => {
    const stamp = formatTimestamp(segment.startedAtMs);
    const speaker = segment.isFinal ? segment.speakerLabel : `${segment.speakerLabel}（未定稿）`;
    const draftTranslation = segment.translationIsFinal === false;
    if (format === 'md') {
      const header = `### [${stamp}] ${speaker}`;
      return segment.translation
        ? `${header}\n\n${segment.text}\n\n> ${draftTranslation ? '未完成譯文：' : ''}${segment.translation}`
        : `${header}\n\n${segment.text}`;
    }
    const header = `[${stamp}] ${speaker}: ${segment.text}`;
    return segment.translation
      ? `${header}\n    ${draftTranslation ? '未完成譯文' : '譯文'}: ${segment.translation}`
      : header;
  });
  const content =
    format === 'md'
      ? `# ${heading}\n\n${lines.join('\n\n')}\n`
      : `${heading}\n${'='.repeat(Math.min(40, heading.length * 2))}\n\n${lines.join('\n\n')}\n`;
  return {
    filename,
    mimeType: format === 'md' ? 'text/markdown' : 'text/plain',
    content,
  };
}

export function downloadTranscript(
  format: TranscriptExportFormat,
  segments: TranscriptSegment[],
  title?: string,
  recordings?: RecordingDuration[],
) {
  const file = buildTranscriptExport(format, segments, title, recordings);
  downloadBlob(file.filename, new Blob([file.content], { type: file.mimeType }));
}
