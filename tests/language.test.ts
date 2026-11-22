import { describe, expect, it } from 'vitest';
import { convertMarkdown, scriptConverter } from '../src/server/language';

describe('Chinese output normalization', () => {
  it('converts confident Chinese text while preserving Japanese and ambiguous kanji', () => {
    const convert = scriptConverter(['zh-TW', 'ja-JP'], true)!;
    expect(convert('会议记录。会社です。会議')).toBe('會議記錄。会社です。会議');
    expect(convert('会議', 'zh')).toBe('會議');
    expect(convert('会社', 'ja-JP')).toBe('会社');
  });

  it('uses the primary Chinese script when a transcript has no script tag', () => {
    const convert = scriptConverter(['zh-TW', 'zh-CN'], true)!;
    expect(convert('会议记录')).toBe('會議記錄');
    expect(convert('會議記錄', 'zh-CN')).toBe('会议记录');
    expect(scriptConverter(['zh-TW', 'zh-CN'])).toBeUndefined();
  });

  it('preserves nested destinations, code, image URLs and reference identifiers', () => {
    const convert = scriptConverter(['zh-TW'])!;
    const markdown =
      '[**会议** ![记录](图(一).png)](https://example.com/会议(记录))\n\n' +
      '[会议][记录] `会议` <https://example.com/会议>\n\n[记录]: https://example.com/记录\n\n' +
      '```text\n会议\n```\n';
    expect(convertMarkdown(markdown, convert)).toBe(
      markdown
        .replace('**会议** ![记录]', '**會議** ![記錄]')
        .replace('[会议][记录]', '[會議][记录]'),
    );
  });
});
