import type { MinutesRecord } from '../../shared/types';

export type MinutesExportFormat = 'md' | 'txt' | 'json';
export type MinutesExportMetadata = Pick<MinutesRecord, 'action' | 'targetLanguage' | 'style'> &
  Partial<Pick<MinutesRecord, 'id' | 'meetingId' | 'createdAt'>>;

export function buildMinutesExport(
  format: MinutesExportFormat,
  markdownContent: string,
  metadata: MinutesExportMetadata,
) {
  const mimeType =
    format === 'md' ? 'text/markdown' : format === 'txt' ? 'text/plain' : 'application/json';
  const content =
    format === 'json' ? JSON.stringify({ ...metadata, markdownContent }, null, 2) : markdownContent;
  return { filename: `minutes.${format}`, mimeType, content };
}
export function downloadMinutes(
  format: MinutesExportFormat,
  markdownContent: string,
  metadata: MinutesExportMetadata,
) {
  const file = buildMinutesExport(format, markdownContent, metadata);
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
