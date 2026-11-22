export interface TimedText {
  startSeconds: number;
  endSeconds: number;
  text: string;
  languageCode?: string;
}
export const transcriptSchema = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startSeconds: { type: 'number' },
          endSeconds: { type: 'number' },
          text: { type: 'string' },
          languageCode: { type: 'string' },
        },
        required: ['startSeconds', 'endSeconds', 'text'],
      },
    },
  },
  required: ['segments'],
};
export function parseTimedTranscript(value: string): TimedText[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('segments' in parsed) ||
    !Array.isArray(parsed.segments) ||
    parsed.segments.length > 10000
  )
    throw new Error('invalid transcript');
  return parsed.segments
    .map((item: unknown) => {
      if (
        !item ||
        typeof item !== 'object' ||
        !('startSeconds' in item) ||
        !('endSeconds' in item) ||
        !('text' in item) ||
        typeof item.startSeconds !== 'number' ||
        !Number.isFinite(item.startSeconds) ||
        item.startSeconds < 0 ||
        typeof item.endSeconds !== 'number' ||
        !Number.isFinite(item.endSeconds) ||
        item.endSeconds < item.startSeconds ||
        typeof item.text !== 'string'
      )
        throw new Error('invalid transcript segment');
      return {
        startSeconds: item.startSeconds,
        endSeconds: item.endSeconds,
        text: item.text.trim(),
        ...('languageCode' in item && typeof item.languageCode === 'string'
          ? { languageCode: item.languageCode }
          : {}),
      };
    })
    .filter((segment) => segment.text)
    .sort((a, b) => a.startSeconds - b.startSeconds);
}
