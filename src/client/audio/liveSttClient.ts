import type { SttClientMessage, SttServerEvent, SttStart } from '../../shared/protocol';

const MAX_BUFFERED_PACKETS = 3000;
const READY_TIMEOUT_MS = 15000;
const PRE_ROLL_MS = 500;

type AudioMessage = Extract<SttClientMessage, { type: 'audio.chunk' }>;
type Outgoing =
  | { wire: AudioMessage; quiet: boolean; bytes: number; speechStart: boolean }
  | { wire: Extract<SttClientMessage, { type: 'audio.commit' | 'audio.end' }> };
export class LiveSttClient {
  private socket?: WebSocket;
  private stopped = false;
  private ready = false;
  private retry = 0;
  private timer?: number;
  private pumpTimer?: number;
  private readyTimer?: number;
  private preRoll: AudioMessage[] = [];
  private queue: Outgoing[] = [];
  private sent: Outgoing[] = [];
  private committed: { messages: Outgoing[]; id?: string }[] = [];
  private connectionId = '';
  private awaitingFinal = new Set<string>();
  private pendingSpeech = 0;
  constructor(
    private start: SttStart,
    private onEvent: (event: SttServerEvent) => void,
  ) {}
  connect() {
    if (this.stopped) return;
    this.ready = false;
    this.connectionId = crypto.randomUUID();
    const socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/stt`,
    );
    this.socket = socket;
    let reason = 'connection_lost';
    this.readyTimer = window.setTimeout(() => {
      reason = 'readiness_timeout';
      socket.close();
    }, READY_TIMEOUT_MS);
    socket.onopen = () => {
      if (!this.stopped && this.socket === socket) socket.send(JSON.stringify(this.start));
    };
    socket.onmessage = (message) => {
      if (this.stopped || this.socket !== socket) return;
      let event: SttServerEvent;
      try {
        event = JSON.parse(message.data) as SttServerEvent;
      } catch {
        return;
      }
      if (event.type === 'session.ready') {
        if (this.ready) return;
        window.clearTimeout(this.readyTimer);
        this.ready = true;
        this.retry = 0;
        // Only quiet, already acknowledged context is replayed ahead of pending audio.
        // Never resend finalized words just to provide pre-roll.
        for (const packet of this.preRoll) socket.send(JSON.stringify(packet));
        this.pump();
      }
      if (event.type === 'transcript.committed') {
        const batch = this.committed.find((item) => !item.id);
        if (batch) batch.id = event.segmentId;
        this.awaitingFinal.add(`${this.connectionId}:${event.segmentId}`);
        return;
      }
      if (event.type === 'session.reconnecting') {
        reason = event.reason;
        socket.close();
        return;
      }
      if (event.type === 'transcript.final' || event.type === 'transcript.interim') {
        const providerId = event.segmentId;
        event.segmentId = `${this.connectionId}:${event.segmentId}`;
        if (event.type === 'transcript.interim') this.awaitingFinal.add(event.segmentId);
        else {
          this.awaitingFinal.delete(event.segmentId);
          const matching = this.committed.findIndex((batch) => batch.id === providerId);
          if (matching >= 0) this.savePreRoll(this.committed.splice(matching, 1)[0].messages);
          else if (this.committed[0] && !this.committed[0].id)
            this.savePreRoll(this.committed.shift()!.messages);
          else if (!this.committed.length) {
            // A provider can finalize before our worklet's next commit. Keep the
            // next locally detected utterance if it has already started.
            let speechStarts = 0;
            const nextSpeech = this.sent.findIndex(
              (packet) => 'speechStart' in packet && packet.speechStart && ++speechStarts === 2,
            );
            this.savePreRoll(nextSpeech < 0 ? this.sent : this.sent.slice(0, nextSpeech));
            this.sent = nextSpeech < 0 ? [] : this.sent.slice(nextSpeech);
          }
          this.pendingSpeech = Math.max(0, this.pendingSpeech - 1);
        }
      }
      if (event.type === 'error' && !event.recoverable) {
        this.stopped = true;
        this.queue = [];
        this.sent = [];
        this.committed = [];
      }
      this.onEvent(event);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.ready = false;
      window.clearTimeout(this.readyTimer);
      window.clearTimeout(this.pumpTimer);
      if (!this.stopped) {
        const replay = this.committed.flatMap((batch) => batch.messages);
        const pending = [...replay, ...this.sent, ...this.queue];
        this.queue = pending.slice(-MAX_BUFFERED_PACKETS);
        if (pending.length > MAX_BUFFERED_PACKETS) this.reportBufferLoss();
        this.committed = [];
        this.sent = [];
        const discardedInterims = [...this.awaitingFinal];
        this.awaitingFinal.clear();
        this.onEvent({
          type: 'session.reconnecting',
          reason,
          track: this.start.track,
          discardedInterims,
        });
        this.timer = window.setTimeout(
          () => this.connect(),
          Math.min(1000 * 2 ** this.retry++, 10000),
        );
      }
    };
    socket.onerror = () => socket.close();
  }
  private pump() {
    window.clearTimeout(this.pumpTimer);
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
    let count = 0;
    while (this.queue.length && count++ < 5 && this.socket.bufferedAmount < 256 * 1024) {
      const message = this.queue.shift()!;
      this.socket.send(JSON.stringify(message.wire));
      this.sent.push(message);
      if (message.wire.type === 'audio.commit') {
        this.committed.push({ messages: this.sent });
        this.sent = [];
      }
      if (this.committed.length > 16) {
        this.committed.shift();
        this.reportBufferLoss();
      }
      if (this.sent.length > MAX_BUFFERED_PACKETS) {
        this.sent.shift();
        this.reportBufferLoss();
      }
    }
    if (this.queue.length) this.pumpTimer = window.setTimeout(() => this.pump(), 20);
  }
  private savePreRoll(packets: Outgoing[]) {
    let bytesLeft = (this.start.sampleRate * 2 * PRE_ROLL_MS) / 1000;
    const tail: AudioMessage[] = [];
    for (let i = packets.length - 1; i >= 0 && bytesLeft > 0; i--) {
      const packet = packets[i];
      if (!('quiet' in packet)) continue;
      if (!packet.quiet) break;
      tail.push(
        packet.bytes <= bytesLeft
          ? packet.wire
          : {
              type: 'audio.chunk',
              pcm16Base64: btoa(atob(packet.wire.pcm16Base64).slice(-bytesLeft)),
            },
      );
      bytesLeft -= packet.bytes;
    }
    this.preRoll = tail.reverse();
  }
  audio(buffer: ArrayBuffer, level = 1, speechStart = false) {
    if (this.stopped) return;
    const bytes = new Uint8Array(buffer);
    const CHUNK = 0x8000;
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
    }
    this.enqueue({
      wire: { type: 'audio.chunk', pcm16Base64: btoa(parts.join('')) },
      quiet: level <= 0.012,
      bytes: buffer.byteLength,
      speechStart,
    });
  }
  private enqueue(packet: Outgoing) {
    this.queue.push(packet);
    if (this.queue.length > MAX_BUFFERED_PACKETS) {
      this.queue.shift();
      this.reportBufferLoss();
    }
    this.pump();
  }
  private reportBufferLoss() {
    this.onEvent({
      type: 'error',
      code: 'audio_buffer_full',
      message: '連線中斷過久，部分音訊未能轉錄；本機錄音仍會保存。',
      recoverable: true,
    });
  }
  noteSpeechStart() {
    if (!this.stopped) this.pendingSpeech++;
  }
  commit() {
    if (!this.stopped) this.enqueue({ wire: { type: 'audio.commit' } });
  }
  endInput() {
    if (this.stopped || this.start.provider !== 'openai') return;
    this.enqueue({ wire: { type: 'audio.end' } });
  }
  async drain(timeoutMs = 10000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (
      (this.queue.length || (this.socket?.bufferedAmount || 0) > 0) &&
      !this.stopped &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    return this.queue.length === 0 && (this.socket?.bufferedAmount || 0) === 0;
  }
  async waitForFinal(timeoutMs = 8000): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const deadline = Date.now() + timeoutMs;
    while (
      (this.awaitingFinal.size > 0 || this.pendingSpeech > 0) &&
      !this.stopped &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    return this.awaitingFinal.size === 0 && this.pendingSpeech === 0;
  }
  stop() {
    this.stopped = true;
    window.clearTimeout(this.timer);
    window.clearTimeout(this.pumpTimer);
    window.clearTimeout(this.readyTimer);
    this.preRoll = [];
    this.queue = [];
    this.committed = [];
    this.sent = [];
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: 'session.stop' }));
    this.socket?.close();
  }
}
