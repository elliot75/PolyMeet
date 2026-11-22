import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditSaveQueue } from '../src/client/services/editSaveQueue';

afterEach(() => vi.useRealTimers());

describe('local edit autosave', () => {
  it('retries a failed edit and lets another meeting export independently', async () => {
    vi.useFakeTimers();
    const first = { meetingId: 'a', text: 'edited draft' };
    const second = { meetingId: 'b', text: 'other draft' };
    const save = vi.fn(async (_edit: typeof first) => {}).mockRejectedValueOnce(new Error('quota'));
    const queue = new EditSaveQueue(save);
    const result = vi.fn();
    queue.schedule('draft-a', first, 250, result);
    await vi.advanceTimersByTimeAsync(250);
    expect(result).toHaveBeenLastCalledWith(false);

    queue.schedule('draft-b', second, 250);
    expect(await queue.flush(({ meetingId }) => meetingId === 'b')).toBe(true);
    expect(save.mock.calls).toEqual([[first], [second]]);
    expect(await queue.flush()).toBe(true);
    expect(save).toHaveBeenLastCalledWith(first);
    expect(result).toHaveBeenLastCalledWith(true);
  });

  it('keeps only the latest revision when an older write fails in flight', async () => {
    let failOld!: (error: Error) => void;
    const save = vi.fn(async (_value: string) => {});
    save.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          failOld = reject;
        }),
    );
    const queue = new EditSaveQueue(save);
    const oldWrite = queue.schedule('draft', 'old', 0);
    await Promise.resolve();
    queue.schedule('draft', 'new', 250);
    failOld(new Error('quota'));
    await oldWrite;
    expect(await queue.flush()).toBe(true);
    expect(save.mock.calls).toEqual([['old'], ['new']]);
  });
});
