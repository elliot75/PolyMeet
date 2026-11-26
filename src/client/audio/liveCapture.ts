import type { SttServerEvent, SttStart } from '../../shared/protocol';
import { LiveSttClient } from './liveSttClient';

export class LiveCapture {
  private nodes: AudioWorkletNode[] = [];
  private clients: LiveSttClient[] = [];
  private context?: AudioContext;
  private onEvent?: (event: SttServerEvent) => void;
  async start(
    tracks: { stream: MediaStream; role: 'mic' | 'system' }[],
    options: Omit<SttStart, 'type' | 'sampleRate' | 'track'>,
    onEvent: (event: SttServerEvent) => void,
    onLevel?: (role: 'mic' | 'system', level: number) => void,
    onSpeechStart?: (role: 'mic' | 'system') => void,
  ) {
    this.onEvent = onEvent;
    const targetRate = options.provider === 'openai' ? 24000 : 16000;
    const maxSpeechSeconds =
      options.provider === 'openai' && options.model.trim() === 'gpt-live-transcribe'
        ? 10
        : undefined;
    const context = new AudioContext();
    this.context = context;
    if (context.state === 'suspended') await context.resume();
    await context.audioWorklet.addModule('/audio-worklet.js');
    for (const track of tracks) {
      const client = new LiveSttClient(
        { type: 'session.start', ...options, sampleRate: targetRate, track: track.role },
        onEvent,
      );
      const source = context.createMediaStreamSource(track.stream);
      const node = new AudioWorkletNode(context, 'pcm-processor', {
        processorOptions: { targetRate, maxSpeechSeconds },
      });
      const silence = context.createGain();
      silence.gain.value = 0;
      source.connect(node).connect(silence).connect(context.destination);
      node.port.onmessage = ({ data }) => {
        if (data.type === 'audio') {
          client.audio(data.buffer, data.level, data.speechStart);
          onLevel?.(track.role, data.level);
        } else if (data.type === 'commit') client.commit();
        else if (data.type === 'speech.start') {
          client.noteSpeechStart();
          onSpeechStart?.(track.role);
        }
      };
      this.nodes.push(node);
      this.clients.push(client);
      client.connect();
    }
  }
  private async flush() {
    if (this.context?.state !== 'running') return;
    await Promise.all(
      this.nodes.map(
        (node) =>
          new Promise<void>((resolve) => {
            const id = crypto.randomUUID();
            const timer = window.setTimeout(done, 1000);
            function done() {
              window.clearTimeout(timer);
              node.port.removeEventListener('message', receive);
              resolve();
            }
            function receive(event: MessageEvent) {
              if (event.data?.type === 'flushed' && event.data.id === id) done();
            }
            node.port.addEventListener('message', receive);
            node.port.postMessage({ type: 'flush', id });
          }),
      ),
    );
  }
  async pause() {
    const context = this.context;
    if (!context || context.state === 'suspended' || context.state === 'closed') return;
    await this.flush();
    await context.suspend();
    for (const client of this.clients) client.endInput();
  }
  async resume() {
    await this.context?.resume();
  }
  async stop() {
    try {
      await this.pause();
      const drained = await Promise.all(this.clients.map((client) => client.drain()));
      if (drained.some((ok) => !ok))
        this.onEvent?.({
          type: 'error',
          code: 'audio_unsent',
          message: '部分音訊尚未轉錄，錄音保存後可使用「轉錄此錄音」。',
          recoverable: true,
        });
      const finalized = await Promise.all(this.clients.map((client) => client.waitForFinal()));
      if (finalized.some((ok) => !ok))
        this.onEvent?.({
          type: 'error',
          code: 'audio_unsent',
          message: '最後一段逐字稿尚未完成，錄音保存後可使用「轉錄此錄音」。',
          recoverable: true,
        });
    } finally {
      await Promise.all(this.clients.map((client) => client.stopAndWait()));
      for (const node of this.nodes) node.disconnect();
      if (this.context?.state !== 'closed') await this.context?.close();
    }
  }
}
