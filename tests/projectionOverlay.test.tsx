import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectionHistory } from '../src/client/components/ProjectionOverlay';
import type { TranscriptSegment } from '../src/shared/types';

const first: TranscriptSegment = {
  id: 'first',
  meetingId: 'meeting',
  track: 'mic',
  speakerLabel: 'Speaker',
  startedAtMs: 0,
  text: 'First original',
  isFinal: true,
  translation: 'First translation',
  translationIsFinal: true,
};
const second: TranscriptSegment = {
  ...first,
  id: 'second',
  startedAtMs: 1000,
  text: 'Second original',
  translation: undefined,
  translationIsFinal: undefined,
};
const draft = { ...second, translation: 'Second draft', translationIsFinal: false };

describe('projection subtitles', () => {
  it('keeps earlier originals and translations paired and in order as a new translation streams', () => {
    const translating = new Map([[second.id, Promise.resolve()]]);
    for (const segment of [second, draft]) {
      const html = renderToStaticMarkup(
        <ProjectionHistory segments={[first, segment]} interim="" translating={translating} />,
      );
      expect(html).toMatch(/First original.*First translation.*Second original/);
      expect(html).toContain('最新字幕');
      expect(html).toContain('翻譯中…');
      expect(html).toContain('projection-entry is-current is-translating');
    }
    const completed = renderToStaticMarkup(
      <ProjectionHistory
        segments={[
          first,
          { ...second, translation: 'Second translation', translationIsFinal: true },
        ]}
        interim=""
        translating={new Map()}
      />,
    );
    expect(completed).toMatch(/First translation.*Second original.*Second translation/);
    expect(completed).not.toContain('翻譯中…');
  });

  it('distinguishes an unfinished translation and shows the current interim once', () => {
    const html = renderToStaticMarkup(
      <ProjectionHistory
        segments={[first, draft, { ...first, id: 'recovered', isFinal: false, text: 'Temporary' }]}
        interim="Live interim"
        translating={new Map()}
      />,
    );
    expect(html).toMatch(/Second original.*未完成譯文：.*Second draft.*辨識中.*Live interim/);
    expect(html).not.toContain('Temporary');
    expect(html).not.toContain('最新字幕');
    expect(html).not.toContain('翻譯中…');
  });
});
