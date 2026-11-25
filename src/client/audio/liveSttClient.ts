import { workspaceAccountId } from '../services/workspaceSession';
import type { SttClientMessage, SttServerEvent, SttStart } from '../../shared/protocol';
import { usesManualCommit } from '../../shared/models';

const MAX_BUFFERED_PACKETS = 3000;
const READY_TIMEOUT_MS = 15000;
const PRE_ROLL_MS = 500;
const PENDING_SPEECH_TTL_MS = 20_000;
// The worklet emits one audio packet per 100 ms during continuous capture.
export const LIVE_AUDIO_REPLAY_MS = MAX_BUFFERED_PACKETS * 100;

type AudioMessage = Extract<SttClientMessage, { type: 'audio.chunk' }>;
type Outgoing =
  | { wire: AudioMessage; quiet: boolean; bytes: number; speechStart: boolean; endByte?: number }
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
  private sentBytes = 0;
  private connectionId = '';
  private awaitingFinal = new Set<string>();
  private pendingSpeechAt: number[] = [];
  private stopWaiters: Array<() => void> = [];
  constructor(
    private start: SttStart,
    private onEvent: (event: SttServerEvent) => void,
  ) {}
  private resolveStopWaiters() {
    if (!this.stopWaiters.length) return;
    const waiters = this.stopWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
  private get sendsCommit(): boolean {
    return (
      usesManualCommit(this.start.provider, this.start.model.trim()) ||
      this.start.provider === 'gemini'
    );
  }
  private hasPendingSpeech(): boolean {
    const cutoff = Date.now() - PENDING_SPEECH_TTL_MS;
    this.pendingSpeechAt = this.pendingSpeechAt.filter((timestamp) => timestamp >= cutoff);
    return this.pendingSpeechAt.length > 0;
  }
  private pruneCommittedOverflow() {
    while (this.committed.length > 16) {
      this.committed.shift();
      this.reportBufferLoss();
    }
  }

  private acknowledgeGeminiAudio(endMs: number | undefined): number {
    let acknowledged: Outgoing[] = [];
    if (endMs !== undefined) {
      const endByte = Math.min(this.sentBytes, (endMs * this.start.sampleRate * 2) / 1000);
      const throughEnd = (packets: Outgoing[]) => {
        const firstPending = packets.findIndex(
          (packet) => 'quiet' in packet && (packet.endByte ?? Infinity) > endByte,
        );
        const removed = packets.splice(0, firstPending < 0 ? packets.length : firstPending);
        acknowledged.push(...removed);
        return packets.length > 0;
      };
      this.committed = this.committed.filter((batch) => throughEnd(batch.messages));
      throughEnd(this.sent);
    } else if (this.committed.length) {
      // Older servers omit offsets. The closed batches can include noise that produced no final.
      acknowledged = this.committed.splice(0).flatMap((batch) => batch.messages);
    } else {
      return 0;
    }
    if (acknowledged.length) this.savePreRoll(acknowledged);
    return Math.max(
      1,
      acknowledged.filter((packet) => 'speechStart' in packet && packet.speechStart).length,
    );
  }
  connect() {
    if (this.stopped) return;
    this.ready = false;
    this.sentBytes = 0;
    this.connectionId = crypto.randomUUID();
    const accountId = workspaceAccountId();
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
      if (!this.stopped && this.socket === socket)
        socket.send(JSON.stringify({ ...this.start, accountId }));
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket) return;
      let event: SttServerEvent;
      try {
        event = JSON.parse(message.data) as SttServerEvent;
      } catch {
        return;
      }
      if (this.stopped) {
        if (event.type === 'usage.recorded') {
          this.onEvent(event);
          this.resolveStopWaiters();
        }
        return;
      }
      if (event.type === 'session.ready') {
        if (this.ready) return;
        window.clearTimeout(this.readyTimer);
        this.ready = true;
        this.retry = 0;
        // Only quiet, already acknowledged context is replayed ahead of pending audio.
        // Never resend finalized words just to provide pre-roll.
        for (const packet of this.preRoll) {
          socket.send(JSON.stringify(packet));
          this.sentBytes += atob(packet.pcm16Base64).length;
        }
        this.pump();
      }
      if (event.type === 'transcript.committed') {
        if (!this.sendsCommit) {
          this.committed.push({
            id: event.segmentId,
            messages: this.sent,
          });
          this.sent = [];
          this.pruneCommittedOverflow();
        } else {
          const batch = this.committed.find((item) => !item.id);
          if (batch) batch.id = event.segmentId;
        }
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
          const geminiAcknowledged =
            this.start.provider === 'gemini' ? this.acknowledgeGeminiAudio(event.audioEndMs) : 0;
          if (!geminiAcknowledged) {
            const matching = this.committed.findIndex((batch) => batch.id === providerId);
            if (matching >= 0) this.savePreRoll(this.committed.splice(matching, 1)[0].messages);
            else if (this.sendsCommit && this.committed[0] && !this.committed[0].id)
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
          }
          this.hasPendingSpeech();
          this.pendingSpeechAt.splice(0, geminiAcknowledged || 1);
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
      this.resolveStopWaiters();
      if (!this.stopped) {
        const replay = this.committed.flatMap((batch) => batch.messages);
        const pending = [...replay, ...this.sent, ...this.queue];
        this.queue = pending.slice(-MAX_BUFFERED_PACKETS);
        if (pending.length > MAX_BUFFERED_PACKETS) {
          this.reportBufferLoss();
          const retainedSpeech = this.queue.filter(
            (item) => 'speechStart' in item && item.speechStart,
          ).length;
          if (retainedSpeech === 0) {
            this.pendingSpeechAt = [];
          } else if (this.pendingSpeechAt.length > retainedSpeech) {
            this.pendingSpeechAt = this.pendingSpeechAt.slice(-retainedSpeech);
          }
        }
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
      if ('quiet' in message) message.endByte = this.sentBytes += message.bytes;
      this.sent.push(message);
      if (message.wire.type === 'audio.commit') {
        if (this.sent.some((item) => 'quiet' in item && !item.quiet)) {
          this.committed.push({ messages: this.sent });
        }
        this.sent = [];
        this.pruneCommittedOverflow();
      }
      if (!this.sendsCommit && this.sent.every((item) => !('quiet' in item) || item.quiet)) {
        const quiet = this.sent.filter((item) => 'quiet' in item);
        let bytes = quiet.reduce((sum, item) => sum + item.bytes, 0);
        const limit = (this.start.sampleRate * 2 * PRE_ROLL_MS) / 1000;
        while (quiet.length > 1 && bytes > limit) bytes -= quiet.shift()!.bytes;
        this.sent = quiet;
      }
      if (this.sent.length > MAX_BUFFERED_PACKETS) {
        const dropped = this.sent.shift();
        if (dropped && 'quiet' in dropped && !dropped.quiet) this.reportBufferLoss();
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
    if (!this.stopped) {
      this.pendingSpeechAt.push(Date.now());
      if (this.pendingSpeechAt.length > 50) this.pendingSpeechAt.shift();
    }
  }
  commit() {
    if (!this.stopped && this.sendsCommit) this.enqueue({ wire: { type: 'audio.commit' } });
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
      (this.awaitingFinal.size > 0 || this.hasPendingSpeech()) &&
      !this.stopped &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    return this.awaitingFinal.size === 0 && !this.hasPendingSpeech();
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
    this.pendingSpeechAt = [];
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: 'session.stop' }));
    this.socket?.close();
    this.resolveStopWaiters();
  }
  async stopAndWait(timeoutMs = 1200) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.stop();
      return;
    }
    this.stopped = true;
    window.clearTimeout(this.timer);
    window.clearTimeout(this.pumpTimer);
    window.clearTimeout(this.readyTimer);
    this.preRoll = [];
    this.queue = [];
    this.committed = [];
    this.sent = [];
    this.pendingSpeechAt = [];
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, timeoutMs);
      this.stopWaiters.push(() => {
        window.clearTimeout(timer);
        resolve();
      });
      socket.send(JSON.stringify({ type: 'session.stop' }));
    });
    if (this.socket === socket) socket.close();
  }
}
