import { describe, expect, it } from 'vitest';
import { convertMarkdown, scriptConverter, streamConvertedText } from '../src/server/language';

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

  it('converts tagged Chinese and preserves untagged Japanese kanji and mixed text', () => {
    const convert = scriptConverter(['简体中文', '日本語'], true)!;
    expect(convert('會議記錄與行動清單。', 'zh-TW')).toBe('会议记录与行动清单。');
    expect(convert('議題：問題と電話・時間')).toBe('議題：問題と電話・時間');
    expect(convert('会議記録')).toBe('会議記録');
  });

  it('preserves forward references and fenced code inside list items across chunks', async () => {
    const convert = scriptConverter(['繁體中文'])!;
    const chunks = [
      '# 会议\n\n詳見 [记录]。\n\n',
      '[记录]: https://example.com/记录\n\n- 方案\n\n  ```text\n  代码\n\n',
      '  记录\n  ```\n',
    ];
    async function* source() {
      yield* chunks;
    }
    const output: string[] = [];
    for await (const part of streamConvertedText(source(), convert, 'minutes')) output.push(part);
    expect(output[0]).toBe('# 會議\n\n');
    expect(output.join('')).toBe(convertMarkdown(chunks.join(''), convert));
    expect(output.join('')).toContain('[记录]。');
    expect(output.join('')).toContain('  代码\n\n  记录');
  });

  it('streams converted minutes per paragraph and translations per sentence while keeping fences intact', async () => {
    const tw = scriptConverter(['繁體中文'])!;
    async function* minutesChunks() {
      yield '# 会议\n\n```code\n简体';
      yield '代码\n```\n\n';
      yield '- 结论更新';
    }
    const minuteParts: string[] = [];
    for await (const part of streamConvertedText(minutesChunks(), tw, 'minutes')) {
      minuteParts.push(part);
    }
    expect(minuteParts).toEqual(['# 會議\n\n', '```code\n简体代码\n```\n\n', '- 結論更新']);

    async function* refMinutesChunks() {
      yield '[会议][ref]\n\n段落一\n\n';
      yield '[ref]: https://example.com/会议';
    }
    const refParts: string[] = [];
    for await (const part of streamConvertedText(refMinutesChunks(), tw, 'minutes')) {
      refParts.push(part);
    }
    expect(refParts.join('')).toBe('[會議][ref]\n\n段落一\n\n[ref]: https://example.com/会议');

    async function* translateChunks() {
      yield '第一';
      yield '句话。第二句';
      yield '话';
    }
    const translateParts: string[] = [];
    for await (const part of streamConvertedText(translateChunks(), tw, 'translate')) {
      translateParts.push(part);
    }
    expect(translateParts).toEqual(['第一句話。', '第二句話']);
  });
});
