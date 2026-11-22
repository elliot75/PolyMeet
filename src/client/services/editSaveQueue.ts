interface PendingWrite<T> {
  value: T;
  timer?: ReturnType<typeof setTimeout>;
  write?: Promise<void>;
  onSettled?: (saved: boolean) => void;
}

/** Serializes local writes and keeps the latest failed value available for retry. */
export class EditSaveQueue<T> {
  private pending = new Map<string, PendingWrite<T>>();
  private tail = Promise.resolve();

  constructor(private save: (value: T) => Promise<unknown>) {}

  schedule(id: string, value: T, delay: number, onSettled?: (saved: boolean) => void) {
    clearTimeout(this.pending.get(id)?.timer);
    const entry: PendingWrite<T> = { value, onSettled };
    this.pending.set(id, entry);
    if (delay > 0) entry.timer = setTimeout(() => void this.write(id, entry), delay);
    else void this.write(id, entry);
  }

  private write(id: string, entry: PendingWrite<T>) {
    clearTimeout(entry.timer);
    if (entry.write) return entry.write;
    const write = this.tail.then(async () => {
      if (this.pending.get(id) !== entry) return;
      let saved = false;
      try {
        await this.save(entry.value);
        saved = true;
      } finally {
        if (this.pending.get(id) === entry) {
          if (saved) this.pending.delete(id);
          else entry.write = undefined;
          entry.onSettled?.(saved);
        }
      }
    });
    entry.write = this.tail = write.catch(() => {});
    return entry.write;
  }

  async flush(inScope: (value: T) => boolean = () => true): Promise<boolean> {
    await Promise.all(
      [...this.pending]
        .filter(([, entry]) => inScope(entry.value))
        .map(([id, entry]) => this.write(id, entry)),
    );
    return ![...this.pending.values()].some((entry) => inScope(entry.value));
  }

  values(): T[] {
    return [...this.pending.values()].map((entry) => entry.value);
  }

  discard(id: string) {
    clearTimeout(this.pending.get(id)?.timer);
    this.pending.delete(id);
  }

  discardWhere(inScope: (value: T) => boolean) {
    for (const [id, entry] of this.pending) if (inScope(entry.value)) this.discard(id);
  }
}
