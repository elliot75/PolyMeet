import type { FileTranscriptSegment } from '../../shared/types';

export interface TimedText extends FileTranscriptSegment {
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
          speaker: { type: 'string' },
        },
        required: ['startSeconds', 'endSeconds', 'text'],
      },
    },
  },
  required: ['segments'],
};
export function parseTimedTranscript(value: string): TimedText[] {
  return parseSegments(JSON.parse(value), 'startSeconds', 'endSeconds');
}

function parseSegments(parsed: unknown, startKey: string, endKey: string): TimedText[] {
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
      if (!item || typeof item !== 'object') throw new Error('invalid transcript segment');
      const {
        [startKey]: start,
        [endKey]: end,
        text,
        languageCode,
        speaker,
      } = item as Record<string, unknown>;
      if (
        typeof start !== 'number' ||
        !Number.isFinite(start) ||
        start < 0 ||
        typeof end !== 'number' ||
        !Number.isFinite(end) ||
        end < start ||
        typeof text !== 'string'
      )
        throw new Error('invalid transcript segment');
      const label = typeof speaker === 'string' ? speaker.trim() : '';
      return {
        startSeconds: start,
        endSeconds: end,
        text: text.trim(),
        ...(typeof languageCode === 'string' ? { languageCode } : {}),
        ...(label && label.length <= 80 ? { speaker: label } : {}),
      };
    })
    .filter((segment) => segment.text)
    .sort((a, b) => a.startSeconds - b.startSeconds);
}

export function openAITranscriptionFormat(model: string) {
  switch (model) {
    case 'whisper-1':
      return {
        response_format: 'verbose_json' as const,
        timestamp_granularities: ['segment' as const],
      };
    case 'gpt-4o-transcribe-diarize':
      return { response_format: 'diarized_json' as const, chunking_strategy: 'auto' as const };
    default:
      return {};
  }
}

export function parseOpenAITranscript(
  result: unknown,
): { segments: FileTranscriptSegment[] } | { text: string } {
  if (typeof result === 'string') return { text: result };
  const text =
    result && typeof result === 'object' && 'text' in result && typeof result.text === 'string'
      ? result.text
      : undefined;
  try {
    const segments = parseSegments(result, 'start', 'end');
    if (segments.length || !text?.trim()) {
      return {
        segments: segments.map(({ startSeconds, endSeconds, text, speaker }) => ({
          startSeconds,
          endSeconds,
          text,
          ...(speaker ? { speaker } : {}),
        })),
      };
    }
  } catch (error) {
    if (text === undefined) throw error;
  }
  return { text: text ?? '' };
}
