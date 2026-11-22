import { describe, expect, it } from 'vitest';
import { SegmentTimeline } from '../src/client/audio/segmentTimeline';

describe('live segment timing', () => {
  it('keeps the original positions when final results arrive out of order', () => {
    const timeline = new SegmentTimeline();
    timeline.noteSpeech('mic', 1000);
    timeline.noteSpeech('mic', 4000);
    expect(timeline.position('first', 'mic', 0)).toBe(1000);
    expect(timeline.position('second', 'mic', 0)).toBe(4000);
    expect(timeline.finish('second', 'mic', 0)).toBe(4000);
    expect(timeline.finish('first', 'mic', 0)).toBe(1000);
  });
  it('keeps the two audio tracks independent', () => {
    const timeline = new SegmentTimeline();
    timeline.noteSpeech('mic', 2000);
    timeline.noteSpeech('system', 1000);
    expect(timeline.finish('system-segment', 'system', 0)).toBe(1000);
    expect(timeline.finish('mic-segment', 'mic', 0)).toBe(2000);
  });
});
