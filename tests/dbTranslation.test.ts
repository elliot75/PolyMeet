import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  listSegments,
  saveMeeting,
  saveSegment,
  updateSegmentTranslation,
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
    await updateSegmentTranslation(segment.id, 'translated');
    expect(await listSegments(segment.meetingId)).toMatchObject([
      { text: 'corrected', translation: 'translated' },
    ]);
  });
});
