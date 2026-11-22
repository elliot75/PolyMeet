import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('audio worklet', () => {
  it('resamples to 16 kHz and commits after speech followed by silence', () => {
    const events: Array<{ type: string; buffer?: ArrayBuffer }> = [];
    let Processor: any;
    class Base {
      port = {
        onmessage: null,
        postMessage: (event: { type: string; buffer?: ArrayBuffer }) => events.push(event),
      };
    }
    const code = readFileSync(new URL('../public/audio-worklet.js', import.meta.url), 'utf8');
    runInNewContext(code, {
      AudioWorkletProcessor: Base,
      sampleRate: 48000,
      registerProcessor: (_name: string, value: unknown) => {
        Processor = value;
      },
      Int16Array,
      Math,
    });
    const processor = new Processor({ processorOptions: { targetRate: 16000 } });
    const samples = new Float32Array(48000 * 2);
    samples.fill(0.2, 0, 48000);
    for (let offset = 0; offset < samples.length; offset += 128)
      processor.process([[samples.subarray(offset, offset + 128)]]);
    const packets = events.filter((event) => event.type === 'audio');
    expect(packets.length).toBeGreaterThanOrEqual(19);
    expect(packets[0].buffer?.byteLength).toBe(3200);
    expect(events.filter((event) => event.type === 'speech.start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'commit')).toHaveLength(1);
    expect(events.findIndex((event) => event.type === 'speech.start')).toBeLessThan(
      events.findIndex((event) => event.type === 'commit'),
    );
  });
  it('commits long continuous speech and flushes the last partial packet', () => {
    const events: Array<{ type: string; id?: string; buffer?: ArrayBuffer }> = [];
    let Processor: any;
    class Base {
      port = {
        onmessage: null,
        postMessage: (event: { type: string; id?: string; buffer?: ArrayBuffer }) =>
          events.push(event),
      };
    }
    const code = readFileSync(new URL('../public/audio-worklet.js', import.meta.url), 'utf8');
    runInNewContext(code, {
      AudioWorkletProcessor: Base,
      sampleRate: 48000,
      registerProcessor: (_name: string, value: unknown) => {
        Processor = value;
      },
      Int16Array,
      Math,
    });
    const processor = new Processor({ processorOptions: { targetRate: 24000 } });
    const samples = new Float32Array(48000 * 19).fill(0.25);
    for (let offset = 0; offset < samples.length; offset += 128)
      processor.process([[samples.subarray(offset, offset + 128)]]);
    expect(events.filter((event) => event.type === 'commit')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'speech.start')).toHaveLength(2);
    const first = events.find((event) => event.type === 'audio')!;
    expect(new Int16Array(first.buffer!)[0]).toBe(8191);
    processor.port.onmessage({ data: { type: 'flush', id: 'test-flush' } });
    expect(events.filter((event) => event.type === 'commit')).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: 'flushed', id: 'test-flush' });
  });
});
