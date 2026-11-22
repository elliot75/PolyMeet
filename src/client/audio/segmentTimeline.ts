import type { AudioTrackRole } from '../../shared/types';

/** Associates a provider's segment ID with the local speech-start time. */
export class SegmentTimeline {
  private starts: Record<'mic' | 'system', number[]> = { mic: [], system: [] };
  private positions = new Map<string, number>();

  noteSpeech(track: 'mic' | 'system', position: number) {
    const pending = this.starts[track];
    pending.push(position);
    if (pending.length > 100) pending.shift();
  }
  position(id: string, track: AudioTrackRole, fallback: number): number {
    const existing = this.positions.get(id);
    if (existing !== undefined) return existing;
    const position =
      (track === 'mic' || track === 'system' ? this.starts[track].shift() : undefined) ?? fallback;
    this.positions.set(id, position);
    return position;
  }
  retry(ids: string[], track: AudioTrackRole) {
    if (track !== 'mic' && track !== 'system') return;
    const positions: number[] = [];
    for (const id of ids) {
      const position = this.positions.get(id);
      if (position !== undefined) positions.push(position);
      this.positions.delete(id);
    }
    this.starts[track] = [...positions, ...this.starts[track]].sort((a, b) => a - b);
  }
  finish(id: string, track: AudioTrackRole, fallback: number): number {
    const position = this.position(id, track, fallback);
    this.positions.delete(id);
    return position;
  }
}
