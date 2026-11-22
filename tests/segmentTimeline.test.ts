import { describe, expect, it } from 'vitest';
import { LIVE_AUDIO_REPLAY_MS } from '../src/client/audio/liveSttClient';
import { SegmentTimeline } from '../src/client/audio/segmentTimeline';

describe('live segment timing', () => {
  it('keeps the original positions when final results arrive out of order', () => {
    const timeline = new SegmentTimeline();
    timeline.noteSpeech('mic', 1000);
    timeline.noteSpeech('mic', 4000);
    expect(timeline.identify('first', 'mic', 0)).toEqual({ id: 'first', startedAtMs: 1000 });
    expect(timeline.identify('second', 'mic', 0)).toEqual({ id: 'second', startedAtMs: 4000 });
    expect(timeline.finish('second', 'mic', 0).startedAtMs).toBe(4000);
    expect(timeline.finish('first', 'mic', 0).startedAtMs).toBe(1000);
  });
  it('keeps the two audio tracks independent', () => {
    const timeline = new SegmentTimeline();
    timeline.noteSpeech('mic', 2000);
    timeline.noteSpeech('system', 1000);
    expect(timeline.finish('system-segment', 'system', 0).startedAtMs).toBe(1000);
    expect(timeline.finish('mic-segment', 'mic', 0).startedAtMs).toBe(2000);
  });
  it('reuses a persisted draft ID and timestamp across provider connections', () => {
    const timeline = new SegmentTimeline();
    timeline.noteSpeech('mic', 1000);
    const draft = timeline.identify('before-reconnect', 'mic', 0);
    timeline.noteSpeech('mic', 2000);
    timeline.retry(['before-reconnect', 'missing-interim'], 'mic');
    expect(timeline.finish('different-upstream-id', 'mic', 8000)).toEqual(draft);
    expect(timeline.finish('next', 'mic', 8000)).toEqual({ id: 'next', startedAtMs: 2000 });
  });
  it('preserves speech anchors across a reconnect or delayed final within the replay window', () => {
    const timeline = new SegmentTimeline();
    timeline.noteSpeech('mic', 10_000);
    timeline.noteSpeech('mic', 42_000);
    expect(timeline.identify('first', 'mic', 45_000).startedAtMs).toBe(10_000);
    expect(timeline.finish('next', 'mic', 45_000).startedAtMs).toBe(42_000);
  });
  it('discards stale unmatched speech anchors while preserving replayed drafts', () => {
    const timeline = new SegmentTimeline();
    timeline.noteSpeech('mic', 1000);
    const replayed = timeline.identify('draft-1', 'mic', 1000);
    timeline.noteSpeech('mic', 5000); // stale noise anchor
    const fallback = LIVE_AUDIO_REPLAY_MS + 10_000;
    timeline.noteSpeech('mic', fallback - 1000);
    timeline.retry(['draft-1'], 'mic');
    expect(timeline.identify('retry-1', 'mic', fallback)).toEqual(replayed);
    expect(timeline.identify('new-speech', 'mic', fallback)).toEqual({
      id: 'new-speech',
      startedAtMs: fallback - 1000,
    });
  });
});
