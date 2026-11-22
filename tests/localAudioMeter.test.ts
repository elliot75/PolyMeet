import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLocalAudioMeter } from '../src/client/audio/localAudioMeter';

function setup() {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setInterval, clearInterval });
  const makeSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const makeAnalyser = (sample: number) => ({
    fftSize: 0,
    getFloatTimeDomainData: vi.fn((samples: Float32Array) => samples.fill(sample)),
    disconnect: vi.fn(),
  });
  const mic = makeSource(),
    system = makeSource();
  const micAnalyser = makeAnalyser(0.125),
    systemAnalyser = makeAnalyser(0.0625);
  const context = {
    state: 'running',
    createMediaStreamSource: vi.fn().mockReturnValueOnce(mic).mockReturnValueOnce(system),
    createAnalyser: vi.fn().mockReturnValueOnce(micAnalyser).mockReturnValueOnce(systemAnalyser),
    close: vi.fn(async () => {}),
  };
  vi.stubGlobal(
    'AudioContext',
    vi.fn(function () {
      return context;
    }),
  );
  return { context, mic, system, micAnalyser, systemAnalyser };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('local audio meter', () => {
  it('measures the microphone without routing audio to speakers and closes its context', () => {
    const { context, mic, micAnalyser } = setup();
    const stream = {} as MediaStream;
    const publish = vi.fn();
    let recording = true;
    const stop = startLocalAudioMeter({ mic: stream }, () => recording, publish);

    expect(context.createMediaStreamSource).toHaveBeenCalledWith(stream);
    expect(mic.connect).toHaveBeenCalledWith(micAnalyser);
    vi.advanceTimersByTime(80);
    expect(publish).toHaveBeenLastCalledWith({ mic: 0.125, system: 0 });
    recording = false;
    vi.advanceTimersByTime(160);
    expect(publish).toHaveBeenCalledTimes(1);
    recording = true;
    vi.advanceTimersByTime(80);
    expect(publish).toHaveBeenCalledTimes(2);

    stop();
    vi.advanceTimersByTime(160);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(mic.disconnect).toHaveBeenCalledOnce();
    expect(micAnalyser.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('samples both inputs separately and keeps the recording mixer open', () => {
    const { context, system, systemAnalyser } = setup();
    const publish = vi.fn();
    const streams = { mic: {} as MediaStream, system: {} as MediaStream };
    const stop = startLocalAudioMeter(
      streams,
      () => true,
      publish,
      context as unknown as AudioContext,
    );
    expect(context.createMediaStreamSource).toHaveBeenNthCalledWith(2, streams.system);
    expect(system.connect).toHaveBeenCalledWith(systemAnalyser);
    vi.advanceTimersByTime(80);
    expect(publish).toHaveBeenLastCalledWith({ mic: 0.125, system: 0.0625 });
    stop();
    expect(system.disconnect).toHaveBeenCalledOnce();
    expect(systemAnalyser.disconnect).toHaveBeenCalledOnce();
    expect(context.close).not.toHaveBeenCalled();
  });
});
