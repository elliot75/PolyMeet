import { describe, expect, it } from 'vitest';
import { buildMinutesExport } from '../src/client/services/exporter';

const metadata = {
  id: 'version-1',
  meetingId: 'meeting-1',
  createdAt: 10,
  action: 'polish' as const,
  targetLanguage: '繁體中文',
  style: 'standard' as const,
};
describe('minutes export', () => {
  it('exports the edited text as Markdown and text', () => {
    const markdown = '# 會議\n- 待辦';
    expect(buildMinutesExport('md', markdown, metadata)).toEqual({
      filename: 'minutes.md',
      mimeType: 'text/markdown',
      content: markdown,
    });
    expect(buildMinutesExport('txt', markdown, metadata)).toEqual({
      filename: 'minutes.txt',
      mimeType: 'text/plain',
      content: markdown,
    });
  });
  it('exports the selected version metadata and current edited text as JSON', () => {
    const file = buildMinutesExport('json', '已修改', metadata);
    expect(file.filename).toBe('minutes.json');
    expect(file.mimeType).toBe('application/json');
    expect(JSON.parse(file.content)).toEqual({ ...metadata, markdownContent: '已修改' });
  });
});

it('creates a download and releases its temporary object URL', async () => {
  const { vi } = await import('vitest');
  const { downloadMinutes } = await import('../src/client/services/exporter');
  vi.useFakeTimers();
  const link = { href: '', download: '', click: vi.fn() };
  vi.stubGlobal('document', { createElement: vi.fn(() => link) });
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout });
  try {
    downloadMinutes('txt', 'meeting notes', metadata);
    expect(link).toMatchObject({ href: 'blob:test', download: 'minutes.txt' });
    expect(link.click).toHaveBeenCalledOnce();
    expect(await (create.mock.calls[0][0] as Blob).text()).toBe('meeting notes');
    await vi.advanceTimersByTimeAsync(1000);
    expect(revoke).toHaveBeenCalledWith('blob:test');
  } finally {
    create.mockRestore();
    revoke.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
