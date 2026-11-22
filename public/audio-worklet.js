class PcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions.targetRate;
    this.ratio = sampleRate / this.targetRate;
    this.position = 0;
    this.samples = [];
    this.packet = [];
    this.speech = false;
    this.silentPackets = 0;
    this.speechPackets = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'flush') {
        if (this.packet.length) this.emit();
        if (this.speech) this.port.postMessage({ type: 'commit' });
        this.speech = false;
        this.silentPackets = 0;
        this.speechPackets = 0;
        this.port.postMessage({ type: 'flushed', id: event.data.id });
      }
    };
  }
  emit() {
    const samples = this.packet;
    this.packet = [];
    let energy = 0;
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const value = Math.max(-1, Math.min(1, samples[i]));
      energy += value * value;
      pcm[i] = value < 0 ? value * 32768 : value * 32767;
    }
    const rms = Math.sqrt(energy / samples.length);
    this.port.postMessage({ type: 'audio', buffer: pcm.buffer, level: rms }, [pcm.buffer]);
    if (rms > 0.012) {
      if (!this.speech) this.port.postMessage({ type: 'speech.start' });
      this.speech = true;
      this.silentPackets = 0;
    } else if (this.speech) this.silentPackets++;
    if (this.speech) this.speechPackets++;
    if (this.speech && (this.silentPackets >= 7 || this.speechPackets >= 180)) {
      this.port.postMessage({ type: 'commit' });
      this.speech = false;
      this.silentPackets = 0;
      this.speechPackets = 0;
    }
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) this.samples.push(input[i]);
    while (this.position + 1 < this.samples.length) {
      const i = Math.floor(this.position),
        fraction = this.position - i;
      this.packet.push(this.samples[i] * (1 - fraction) + this.samples[i + 1] * fraction);
      this.position += this.ratio;
      if (this.packet.length >= this.targetRate / 10) this.emit();
    }
    const consumed = Math.floor(this.position);
    if (consumed) {
      this.samples.splice(0, consumed);
      this.position -= consumed;
    }
    return true;
  }
}
registerProcessor('pcm-processor', PcmProcessor);
