export type AudioLevels = { mic: number; system: number };

export function startLocalAudioMeter(
  streams: { mic: MediaStream; system?: MediaStream },
  isRecording: () => boolean,
  publish: (levels: AudioLevels) => void,
  mixer?: AudioContext,
): () => void {
  const context = mixer ?? new AudioContext();
  const nodes: AudioNode[] = [];
  let timer: number | undefined;
  const stop = () => {
    window.clearInterval(timer);
    for (const node of nodes) node.disconnect();
    if (!mixer && context.state !== 'closed') void context.close().catch(() => {});
  };

  function sampler(stream: MediaStream) {
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    nodes.push(source, analyser);
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    return () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      return Math.sqrt(sum / samples.length);
    };
  }

  try {
    const mic = sampler(streams.mic);
    const system = streams.system && sampler(streams.system);
    if (context.state === 'suspended') void context.resume().catch(() => {});
    timer = window.setInterval(() => {
      if (context.state === 'running' && isRecording())
        publish({ mic: mic(), system: system?.() ?? 0 });
    }, 80);
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
