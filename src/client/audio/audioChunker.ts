const RATE = 16000;
const SECONDS = 600;
const MIN_PART_SECONDS = 0.2;
export const OPENAI_MAX_AUDIO_SECONDS = 1200;
export function encodeWav(samples: Float32Array, rate = RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2),
    view = new DataView(buffer);
  const str = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const n = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, n < 0 ? n * 32768 : n * 32767, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
export async function* splitAudio(
  file: File,
  completedParts = 0,
  signal?: AbortSignal,
  forceSplit = false,
): AsyncGenerator<{
  file: File;
  offsetMs: number;
  index: number;
  total: number;
  durationSeconds?: number;
}> {
  signal?.throwIfAborted();
  const fitsUpload = file.size <= 23 * 1024 * 1024;
  if (fitsUpload && (!forceSplit || typeof AudioContext === 'undefined')) {
    if (!completedParts) yield { file, offsetMs: 0, index: 1, total: 1 };
    return;
  }
  const context = new AudioContext();
  try {
    const buffer = await file.arrayBuffer();
    signal?.throwIfAborted();
    const audio = await context.decodeAudioData(buffer).catch((error: unknown) => {
      // A provider can accept codecs that the browser cannot decode locally.
      if (!fitsUpload) throw error;
      return undefined;
    });
    signal?.throwIfAborted();
    if (fitsUpload && (!audio || audio.duration <= OPENAI_MAX_AUDIO_SECONDS)) {
      if (!completedParts)
        yield { file, offsetMs: 0, index: 1, total: 1, durationSeconds: audio?.duration };
      return;
    }
    if (!audio) return;
    const ranges: { offset: number; duration: number }[] = [];
    for (let offset = 0; offset < audio.duration; offset += SECONDS) {
      ranges.push({ offset, duration: Math.min(SECONDS, audio.duration - offset) });
    }
    const tail = ranges.at(-1);
    if (ranges.length >= 2 && tail && tail.duration < MIN_PART_SECONDS) {
      ranges.pop();
      ranges[ranges.length - 1].duration += tail.duration;
    }
    const total = ranges.length;
    for (let index = completedParts; index < total; index++) {
      signal?.throwIfAborted();
      const { offset, duration } = ranges[index];
      const offline = new OfflineAudioContext(1, Math.ceil(duration * RATE), RATE);
      const source = offline.createBufferSource();
      source.buffer = audio;
      source.connect(offline.destination);
      source.start(0, offset, duration);
      const rendered = await offline.startRendering();
      signal?.throwIfAborted();
      yield {
        file: new File([encodeWav(rendered.getChannelData(0))], `part-${index + 1}.wav`, {
          type: 'audio/wav',
        }),
        offsetMs: offset * 1000,
        index: index + 1,
        total,
        durationSeconds: duration,
      };
    }
  } finally {
    await context.close().catch(() => {});
  }
}
