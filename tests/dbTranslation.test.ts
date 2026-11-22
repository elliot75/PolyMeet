import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  listSegments,
  saveMeeting,
  saveSegment,
  updateSegmentTranslation,
  updateSegmentText,
} from '../src/client/db/meetingDb';

describe('translation persistence', () => {
  it('preserves transcript edits when a late translation is saved', async () => {
    await saveMeeting({
      id: 'translation-meeting',
      title: 'Translation',
      createdAt: 1,
      notes: '',
      mode: '一般會議',
    });
    const segment = {
      id: 'translation-test',
      meetingId: 'translation-meeting',
      track: 'mic' as const,
      speakerLabel: '我方',
      startedAtMs: 0,
      text: 'original',
      isFinal: true,
    };
    await saveSegment(segment);
    await saveSegment({ ...segment, text: 'corrected' });
    await updateSegmentTranslation(segment.id, 'draft', false);
    expect(await listSegments(segment.meetingId)).toMatchObject([
      { text: 'corrected', translation: 'draft', translationIsFinal: false },
    ]);
    await updateSegmentTranslation(segment.id, 'translated');
    await updateSegmentTranslation(segment.id, 'late draft', false);
    expect(await listSegments(segment.meetingId)).toMatchObject([
      { text: 'corrected', translation: 'translated', translationIsFinal: true },
    ]);

    await updateSegmentText(segment.id, 'edited again');
    expect(await updateSegmentTranslation(segment.id, 'stale', true, 'corrected')).toBe(false);
    expect(await listSegments(segment.meetingId)).toMatchObject([
      { text: 'edited again', translation: undefined, translationIsFinal: undefined },
    ]);
    expect(await updateSegmentTranslation(segment.id, 'fresh', true, 'edited again')).toBe(true);
    expect(await listSegments(segment.meetingId)).toMatchObject([
      { text: 'edited again', translation: 'fresh', translationIsFinal: true },
    ]);
  });
});
