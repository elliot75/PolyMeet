import { describe, expect, it } from 'vitest';
import { parseTimedTranscript } from '../src/server/providers/transcription';
describe('timed transcription', () => {
  it('sorts validated utterances and removes empty text', () => {
    expect(
      parseTimedTranscript(
        JSON.stringify({
          segments: [
            { startSeconds: 2, endSeconds: 3, text: ' second ' },
            { startSeconds: 0, endSeconds: 1, text: 'first' },
            { startSeconds: 4, endSeconds: 4, text: ' ' },
          ],
        }),
      ),
    ).toEqual([
      { startSeconds: 0, endSeconds: 1, text: 'first' },
      { startSeconds: 2, endSeconds: 3, text: 'second' },
    ]);
  });
  it('rejects invalid timestamps and malformed responses', () => {
    expect(() =>
      parseTimedTranscript('{"segments":[{"startSeconds":3,"endSeconds":1,"text":"x"}]}'),
    ).toThrow();
    expect(() => parseTimedTranscript('{"text":"x"}')).toThrow();
  });
});
