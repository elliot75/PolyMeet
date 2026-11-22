import type { MinutesRecord, TranscriptSegment } from '../../shared/types';

export type MinutesExportFormat = 'md' | 'txt' | 'json';
export type TranscriptExportFormat = 'md' | 'txt';
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

function triggerDownload(filename: string, mimeType: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  triggerDownload(file.filename, file.mimeType, file.content);
}

export function buildTranscriptExport(
  format: TranscriptExportFormat,
  segments: TranscriptSegment[],
  title?: string,
) {
  const safeTitle = title ? sanitizeFilename(title) : '';
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
    filename: safeTitle ? `${safeTitle}-transcript.${format}` : `transcript.${format}`,
    mimeType: format === 'md' ? 'text/markdown' : 'text/plain',
    content,
  };
}

export function downloadTranscript(
  format: TranscriptExportFormat,
  segments: TranscriptSegment[],
  title?: string,
) {
  const file = buildTranscriptExport(format, segments, title);
  triggerDownload(file.filename, file.mimeType, file.content);
}
