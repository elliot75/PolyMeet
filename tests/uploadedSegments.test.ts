import { describe, expect, it } from 'vitest';
import { uploadedSegments } from '../src/client/audio/uploadedSegments';

const recording = { id: 'recording', meetingId: 'meeting' };
const first = { index: 1, total: 2, offsetMs: 0 };
const second = { index: 2, total: 2, offsetMs: 600_000 };

describe('uploaded file segments', () => {
  it('aligns segment timestamps to the original recording and isolates independent speaker labels', () => {
    const result = {
      segments: [{ startSeconds: 1.25, endSeconds: 2.5, text: 'hi', speaker: 'A' }],
    };
    const [early] = uploadedSegments(result, recording, first);
    const [late] = uploadedSegments(result, recording, second);
    expect(late).toMatchObject({
      meetingId: recording.meetingId,
      recordingId: recording.id,
      text: 'hi',
      startedAtMs: 601_250,
      endedAtMs: 602_500,
      timeIsChunkStart: false,
      speakerLabel: 'A（第 2 部分）',
    });
    expect(early.speakerLabel).not.toBe(late.speakerLabel);
    expect(uploadedSegments(result, recording, { ...first, total: 1 })[0].speakerLabel).toBe('A');
  });

  it('uses the generic label for text-only results without inventing segment times', () => {
    expect(uploadedSegments({ text: ' hello ' }, recording, second)[0]).toMatchObject({
      speakerLabel: '音檔',
      startedAtMs: 600_000,
      endedAtMs: undefined,
      timeIsChunkStart: true,
      text: 'hello',
    });
    expect(uploadedSegments({ segments: [] }, recording, second)).toEqual([]);
  });
});
