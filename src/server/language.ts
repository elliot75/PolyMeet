import { Converter } from 'opencc-js';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';

const traditional = Converter({ from: 'cn', to: 'tw' });
const simplified = Converter({ from: 'tw', to: 'cn' });

const japaneseStandard = Converter({ from: 'jp', to: 't' });

function chineseScript(language: string) {
  if (['繁體中文', 'zh-tw', 'zh-hant'].includes(language)) return traditional;
  if (['简体中文', '簡體中文', 'zh-cn', 'zh-hans'].includes(language)) return simplified;
}

export function scriptConverter(
  languages: string[],
  preferPrimary = false,
): ((text: string, detectedLanguage?: string) => string) | undefined {
  const values = languages.map((value) => value.trim().toLowerCase());
  const scripts = [...new Set(values.map(chineseScript).filter(Boolean))];
  const japanese = values.some((value) => ['日本語', 'japanese', 'ja-jp', 'ja'].includes(value));
  if (scripts.length === 0) return undefined;
  if (scripts.length > 1 && !preferPrimary) return undefined;
  const preferred = scripts[0]!;
  if (scripts.length === 1 && !japanese) return preferred;

  return (text, detectedLanguage) => {
    const language = typeof detectedLanguage === 'string' ? detectedLanguage.toLowerCase() : '';
    if (language && /^ja(?:-|$)/.test(language)) return text;
    const explicit = language && chineseScript(language);
    if (explicit) return scripts.length === 1 ? preferred(text) : explicit(text);
    if (language && /^zh(?:-|$)/.test(language)) return preferred(text);
    if (scripts.length > 1 || !japanese) return preferred(text);
    // Untagged Han text can be Japanese even when it contains no kana or shinjitai.
    if (preferred === simplified) return text;
    return text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu, (run) => {
      if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(run)) return run;
      const standard = japaneseStandard(run);
      return traditional(standard) === standard ? run : preferred(run);
    });
  };
}

function findTranslateFlushOffset(text: string): number {
  const boundary = /(?:\n+|[。！？!?][」』”’"')\]）]*|[.!?](?=\s))/g;
  let lastEnd = 0;
  for (const match of text.matchAll(boundary)) {
    lastEnd = (match.index ?? 0) + match[0].length;
  }
  return lastEnd;
}

function findMinutesFlushOffset(text: string): number {
  let flushOffset = 0;
  for (const block of fromMarkdown(text).children) {
    const start = block.position?.start.offset;
    const end = block.position?.end.offset;
    if (start === undefined || end === undefined) break;
    const raw = text.slice(start, end);
    // A later definition can turn brackets in an already emitted block into a reference.
    if (block.type === 'paragraph' || block.type === 'heading') {
      if (raw.includes('[')) break;
    } else if (block.type === 'code') {
      const marker = raw.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
      const closing = raw.slice(raw.lastIndexOf('\n') + 1).trim();
      if (
        !marker ||
        !raw.includes('\n') ||
        !closing.startsWith(marker) ||
        ![...closing].every((char) => char === marker[0])
      )
        break;
    } else {
      // Container blocks can continue across blank lines. Keep their Markdown context intact.
      break;
    }
    const separator = text.slice(end).match(/^[ \t]*\r?\n[ \t]*\r?\n/);
    if (!separator) break;
    flushOffset = end + separator[0].length;
  }
  return flushOffset;
}

export async function* streamConvertedText(
  source: AsyncIterable<string>,
  convert: (value: string) => string,
  mode: 'translate' | 'minutes',
): AsyncGenerator<string> {
  let buffered = '';
  const apply = mode === 'minutes' ? (value: string) => convertMarkdown(value, convert) : convert;
  const findOffset = mode === 'minutes' ? findMinutesFlushOffset : findTranslateFlushOffset;
  for await (const chunk of source) {
    if (!chunk) continue;
    buffered += chunk;
    const cut = findOffset(buffered);
    if (cut > 0) {
      const ready = buffered.slice(0, cut);
      buffered = buffered.slice(cut);
      const converted = apply(ready);
      if (converted) yield converted;
    }
  }
  if (buffered) {
    const converted = apply(buffered);
    if (converted) yield converted;
  }
}

export function languageInstruction(languages: string[]): string {
  return `Strictly follow the selected language or languages: ${languages.join(', ')}. When Traditional Chinese is selected, use Traditional Chinese characters (繁體中文), never Simplified Chinese. When Simplified Chinese is selected, use Simplified Chinese characters (简体中文), never Traditional Chinese. Preserve proper nouns and do not translate text into unselected languages.`;
}

export function convertMarkdown(text: string, convert: (value: string) => string): string {
  const edits: { start: number; end: number; value: string }[] = [];
  function visit(node: Nodes) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const raw = text.slice(start, end);
    if (node.type === 'link' && raw.startsWith('<')) return;
    if (node.type === 'linkReference' && node.referenceType !== 'full') return;
    if (node.type === 'text' || node.type === 'image' || node.type === 'imageReference') {
      // Image labels are represented as a string, so read their source up to the closing label.
      const label = node.type === 'text' ? raw : raw.match(/^!\[((?:\\.|[^\]\\])*)\]/)?.[1];
      if (label === undefined || (node.type === 'imageReference' && node.referenceType !== 'full'))
        return;
      const offset = node.type === 'text' ? start : start + 2;
      const value = label
        .split(/(https?:\/\/[^\s<>]+)/g)
        .map((part, index) => (index % 2 ? part : convert(part)))
        .join('');
      edits.push({ start: offset, end: offset + label.length, value });
    }
    if ('children' in node) node.children.forEach(visit);
  }
  visit(fromMarkdown(text));
  let result = '';
  let cursor = 0;
  for (const { start, end, value } of edits) {
    result += text.slice(cursor, start) + value;
    cursor = end;
  }
  return result + text.slice(cursor);
}
