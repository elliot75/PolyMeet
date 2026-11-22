import { describe, expect, it } from 'vitest';
import { encodeWav } from '../src/client/audio/audioChunker';
import { normalizeAudioMime } from '../src/client/audio/audioMime';
describe('WAV encoding', () => {
  it('writes a mono PCM header and clips samples', async () => {
    const blob = encodeWav(new Float32Array([-2, 0, 2]), 16000);
    const data = new DataView(await blob.arrayBuffer());
    expect(blob.size).toBe(50);
    expect(data.getUint32(24, true)).toBe(16000);
    expect(data.getUint16(22, true)).toBe(1);
    expect(data.getInt16(44, true)).toBe(-32768);
    expect(data.getInt16(48, true)).toBe(32767);
  });
});

describe('large audio segmentation', () => {
  it('splits decoded audio into ten-minute WAV files and preserves offsets', async () => {
    const { vi } = await import('vitest');
    const { splitAudio } = await import('../src/client/audio/audioChunker');
    const calls: Array<{ offset: number; duration: number; rate: number }> = [];
    class MockAudioContext {
      async decodeAudioData() {
        return { duration: 1300 };
      }
      async close() {}
    }
    class MockOfflineAudioContext {
      destination = {};
      constructor(
        _channels: number,
        _length: number,
        private rate: number,
      ) {}
      createBufferSource() {
        return {
          buffer: null,
          connect() {},
          start: (_when: number, offset: number, duration: number) =>
            calls.push({ offset, duration, rate: this.rate }),
        };
      }
      async startRendering() {
        return { getChannelData: () => new Float32Array([0, 0.5]) };
      }
    }
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('OfflineAudioContext', MockOfflineAudioContext);
    try {
      const input = new File([new Uint8Array(23 * 1024 * 1024 + 1)], 'large.wav', {
        type: 'audio/wav',
      });
      const parts = [];
      for await (const part of splitAudio(input)) parts.push(part);
      expect(parts.map((part) => [part.offsetMs, part.index, part.total])).toEqual([
        [0, 1, 3],
        [600000, 2, 3],
        [1200000, 3, 3],
      ]);
      expect(calls).toEqual([
        { offset: 0, duration: 600, rate: 16000 },
        { offset: 600, duration: 600, rate: 16000 },
        { offset: 1200, duration: 100, rate: 16000 },
      ]);
      expect(parts.every((part) => part.file.type === 'audio/wav')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps sub-200ms tails and splits long compressed files', async () => {
    const { vi } = await import('vitest');
    const { splitAudio } = await import('../src/client/audio/audioChunker');
    let decodedDuration = 600.05;
    const renderDurations: number[] = [];
    class MockAudioContext {
      async decodeAudioData() {
        return { duration: decodedDuration };
      }
      async close() {}
    }
    class MockOfflineAudioContext {
      destination = {};
      createBufferSource() {
        return {
          buffer: null,
          connect() {},
          start(_when: number, _offset: number, duration: number) {
            renderDurations.push(duration);
          },
        };
      }
      async startRendering() {
        return { getChannelData: () => new Float32Array([0, 0.25]) };
      }
    }
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('OfflineAudioContext', MockOfflineAudioContext);
    try {
      const large = new File([new Uint8Array(23 * 1024 * 1024 + 1)], 'tiny-tail.wav', {
        type: 'audio/wav',
      });
      const tailParts = [];
      for await (const part of splitAudio(large)) tailParts.push(part);
      expect(tailParts.map((part) => [part.index, part.total])).toEqual([[1, 1]]);
      expect(renderDurations).toEqual([600.05]);

      decodedDuration = 1250;
      const smallCompressed = new File([new Uint8Array(1024)], 'long-meeting.webm', {
        type: 'audio/webm',
      });
      const forcedParts = [];
      for await (const part of splitAudio(smallCompressed, 0, undefined, true)) {
        forcedParts.push(part);
      }
      expect(forcedParts.map((part) => [part.offsetMs, part.index, part.total])).toEqual([
        [0, 1, 3],
        [600_000, 2, 3],
        [1_200_000, 3, 3],
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('audio MIME normalization', () => {
  it('maps container-mislabeled types and extensions to audio/*', () => {
    expect(normalizeAudioMime('video/webm;codecs=opus', 'call.webm')).toBe(
      'audio/webm;codecs=opus',
    );
    expect(normalizeAudioMime('video/mp4', 'voice.m4a')).toBe('audio/mp4');
    expect(normalizeAudioMime('application/ogg', 'clip.ogg')).toBe('audio/ogg');
    expect(normalizeAudioMime('', 'notes.M4A')).toBe('audio/mp4');
    expect(normalizeAudioMime('image/png', 'photo.png')).toBe('');
  });
});
