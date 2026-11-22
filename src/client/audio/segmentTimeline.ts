import type { AudioTrackRole } from '../../shared/types';

interface Anchor {
  startedAtMs: number;
  id?: string;
}

type SegmentAnchor = Required<Anchor>;

/** Keeps a speech start and its draft ID stable when a provider turn is replayed. */
export class SegmentTimeline {
  private starts: Record<'mic' | 'system', Anchor[]> = { mic: [], system: [] };
  private positions = new Map<string, SegmentAnchor>();

  noteSpeech(track: 'mic' | 'system', position: number) {
    const pending = this.starts[track];
    pending.push({ startedAtMs: position });
    if (pending.length > 100) pending.shift();
  }
  identify(id: string, track: AudioTrackRole, fallback: number): SegmentAnchor {
    const existing = this.positions.get(id);
    if (existing) return existing;
    const anchor = track === 'mic' || track === 'system' ? this.starts[track].shift() : undefined;
    const identified = { startedAtMs: anchor?.startedAtMs ?? fallback, id: anchor?.id ?? id };
    this.positions.set(id, identified);
    return identified;
  }
  retry(ids: string[], track: AudioTrackRole) {
    if (track !== 'mic' && track !== 'system') return;
    const anchors: SegmentAnchor[] = [];
    for (const id of ids) {
      const anchor = this.positions.get(id);
      if (anchor) anchors.push(anchor);
      this.positions.delete(id);
    }
    this.starts[track] = [...anchors, ...this.starts[track]].sort(
      (a, b) => a.startedAtMs - b.startedAtMs,
    );
  }
  finish(id: string, track: AudioTrackRole, fallback: number): SegmentAnchor {
    const anchor = this.identify(id, track, fallback);
    this.positions.delete(id);
    return anchor;
  }
}
