export const AUDIO_EXTENSIONS: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
};

export function normalizeAudioMime(mimeType: string, filename = ''): string {
  const trimmed = mimeType.trim();
  const paramIndex = trimmed.indexOf(';');
  const base = (paramIndex >= 0 ? trimmed.slice(0, paramIndex) : trimmed).trim().toLowerCase();
  const params = paramIndex >= 0 ? trimmed.slice(paramIndex) : '';
  if (base.startsWith('audio/')) return `${base}${params}`;
  if (base === 'video/webm' || base === 'video/mp4' || base === 'video/ogg') {
    return `${base.replace(/^video\//, 'audio/')}${params}`;
  }
  if (base === 'application/ogg') return `audio/ogg${params}`;
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return AUDIO_EXTENSIONS[ext] || '';
}
