import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectionOverlay } from '../src/client/components/ProjectionOverlay';
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
const second = {
  ...first,
  id: 'second',
  startedAtMs: 1000,
  text: 'Second original',
  translation: '',
};

describe('projection subtitles', () => {
  it('keeps a previous translation visible until the latest one starts streaming', () => {
    const waiting = renderToStaticMarkup(
      <ProjectionOverlay segments={[first, second]} interim="" />,
    );
    expect(waiting).toContain('First translation');
    expect(waiting).toContain('先前譯文');
    expect(waiting).toContain('Second original');

    const streaming = renderToStaticMarkup(
      <ProjectionOverlay
        segments={[first, { ...second, translation: 'Second draft', translationIsFinal: false }]}
        interim=""
      />,
    );
    expect(streaming).toContain('Second draft');
    expect(streaming).not.toContain('First translation');
    expect(streaming).not.toContain('先前譯文');
  });
});
