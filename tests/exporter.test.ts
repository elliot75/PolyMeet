import { describe, expect, it } from 'vitest';
import {
  buildMinutesExport,
  buildTranscriptExport,
  formatSubtitleTimestamp,
} from '../src/client/services/exporter';
import type { TranscriptSegment } from '../src/shared/types';

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
  it('sanitizes custom filename prefixes and formats bilingual transcripts', () => {
    expect(buildMinutesExport('md', 'x', metadata, 'Q4 / 專案:討論').filename).toBe(
      'Q4-專案-討論-minutes.md',
    );
    const segments = [
      {
        id: '1',
        meetingId: 'm1',
        track: 'mic' as const,
        speakerLabel: '我方',
        startedAtMs: 65000,
        text: '早安',
        translation: 'Good morning',
        isFinal: true,
      },
    ];
    const md = buildTranscriptExport('md', segments, '週會');
    expect(md.filename).toBe('週會-transcript.md');
    expect(md.content).toContain('### [1:05] 我方');
    expect(md.content).toContain('> Good morning');
    const txt = buildTranscriptExport('txt', segments, '週會');
    expect(txt.content).toContain('[1:05] 我方: 早安');
    expect(txt.content).toContain('譯文: Good morning');
  });
});

describe('subtitle export', () => {
  const segment: TranscriptSegment = {
    id: 'cue',
    meetingId: 'meeting-1',
    recordingId: 'clip-a',
    track: 'mic',
    speakerLabel: '我方',
    startedAtMs: 0,
    text: '第一句',
    isFinal: true,
  };

  it('formats hours, minutes, seconds, and milliseconds with the correct separator', () => {
    expect(formatSubtitleTimestamp(3_661_042, 'srt')).toBe('01:01:01,042');
    expect(formatSubtitleTimestamp(59_999.7, 'vtt')).toBe('00:01:00.000');
    expect(formatSubtitleTimestamp(-1, 'vtt')).toBe('00:00:00.000');
  });

  it('exports original and translated lines in both subtitle formats', () => {
    const segments = [
      {
        ...segment,
        startedAtMs: 600,
        text: '你好\n\n<測試>',
        translation: 'Hello & welcome',
        endedAtMs: 1390,
      },
      { ...segment, id: 'cue-2', startedAtMs: 2000, text: '再見' },
    ];
    expect(buildTranscriptExport('srt', segments, '週會')).toEqual({
      filename: '週會-transcript.srt',
      mimeType: 'application/x-subrip',
      content:
        '1\n00:00:00,600 --> 00:00:01,390\n你好\n&lt;測試&gt;\nHello &amp; welcome\n\n2\n00:00:02,000 --> 00:00:03,000\n再見\n',
    });
    expect(buildTranscriptExport('vtt', segments)).toEqual({
      filename: 'transcript.vtt',
      mimeType: 'text/vtt',
      content:
        'WEBVTT\n\n00:00:00.600 --> 00:00:01.390\n你好\n&lt;測試&gt;\nHello &amp; welcome\n\n00:00:02.000 --> 00:00:03.000\n再見\n',
    });
  });

  it('bounds estimated end times and offsets later recordings by preceding audio duration', () => {
    const segments = [
      { ...segment, startedAtMs: 200 },
      { ...segment, id: 'cue-2', startedAtMs: 410, text: '字'.repeat(120), endedAtMs: 100 },
      { ...segment, id: 'cue-3', recordingId: 'clip-b', endedAtMs: 950 },
    ];
    const vtt = buildTranscriptExport('vtt', segments, undefined, [
      { id: 'clip-a', durationSeconds: 8 },
    ]);
    expect(vtt.content.match(/.* --> .*/g)).toEqual([
      '00:00:00.200 --> 00:00:00.410',
      '00:00:00.410 --> 00:00:06.410',
      '00:00:08.000 --> 00:00:08.950',
    ]);
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
