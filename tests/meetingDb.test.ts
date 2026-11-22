import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import {
  exportMeetingArchive,
  getRecordingBlob,
  importMeetingArchive,
  listMeetings,
  listMinutes,
  listRecordings,
  listSegments,
  migrateMeetings,
  renameSegmentSpeaker,
  saveAudioChunk,
  saveInterimSegment,
  saveMeeting,
  saveMinutes,
  saveRecording,
  saveSegment,
  saveSegments,
  searchMeetingContent,
  updateSegmentTranslation,
} from '../src/client/db/meetingDb';
import { buildMeetingArchive, readMeetingArchive } from '../src/client/services/meetingArchive';
import type { MinutesRecord, TranscriptSegment } from '../src/shared/types';

describe('meeting database', () => {
  it('migrates without overwriting newer meetings and retains ordered recording chunks', async () => {
    const meeting = {
      id: 'meeting-1',
      title: 'New',
      createdAt: 1,
      notes: 'saved',
      mode: '一般會議',
    };
    await saveMeeting(meeting);
    await migrateMeetings([
      { ...meeting, title: 'Old' },
      { ...meeting, id: 'meeting-2' },
    ]);
    expect((await listMeetings()).find((m) => m.id === meeting.id)?.title).toBe('New');
    const recording = {
      id: 'recording-1',
      meetingId: meeting.id,
      createdAt: 2,
      mimeType: 'audio/webm',
      completed: false,
    };
    await saveRecording(recording);
    await saveAudioChunk(recording.id, 1, new Blob(['second']));
    await saveAudioChunk(recording.id, 0, new Blob(['first']));
    expect(await listRecordings(meeting.id)).toEqual([recording]);
    expect(await (await getRecordingBlob(recording)).text()).toBe('firstsecond');
  });
  it('rolls back every segment when saving an uploaded part fails', async () => {
    const meetingId = 'upload-part-meeting';
    await saveMeeting({
      id: meetingId,
      title: 'Upload',
      createdAt: 1,
      notes: '',
      mode: '一般會議',
    });
    const first = {
      id: 'upload-part-first',
      meetingId,
      track: 'upload' as const,
      speakerLabel: '音檔',
      startedAtMs: 0,
      text: 'first',
      isFinal: true,
    };
    const second = { ...first, id: 'upload-part-second', startedAtMs: 1000, text: 'second' };
    const uncloneable = { ...second, toJSON: () => second };
    await expect(saveSegments(meetingId, [first, uncloneable])).rejects.toThrow();
    expect(await listSegments(meetingId)).toEqual([]);
    await saveSegments(meetingId, [first, second]);
    expect(await listSegments(meetingId)).toEqual([first, second]);
  });

  it('recovers the latest draft until a final replaces it, and never overwrites that final', async () => {
    const meetingId = 'recover-drafts';
    await saveMeeting({
      id: meetingId,
      title: 'Recovery',
      createdAt: 1,
      notes: '',
      mode: '一般會議',
    });
    const recordingId = 'recover-recording';
    await saveRecording({
      id: recordingId,
      meetingId,
      createdAt: 2,
      completed: false,
      mimeType: 'audio/webm',
    });
    const draft = {
      id: 'recover-draft',
      meetingId,
      recordingId,
      track: 'mic' as const,
      speakerLabel: '我方',
      startedAtMs: 1250,
      text: 'partial',
      isFinal: false,
    };
    await saveInterimSegment(draft);
    await saveInterimSegment({ ...draft, text: 'latest partial' });
    expect(await listSegments(meetingId)).toEqual([{ ...draft, text: 'latest partial' }]);
    const final = { ...draft, text: 'finished sentence', isFinal: true };
    await saveSegment(final);
    await saveInterimSegment({ ...draft, text: 'stale partial' });
    expect(await listSegments(meetingId)).toEqual([final]);
  });

  it('renames one segment or matching labels in its recording without touching other fields', async () => {
    const meeting = {
      id: 'speaker-meeting',
      title: 'Speaker',
      createdAt: 1,
      notes: '',
      mode: '一般會議',
    };
    const other = { ...meeting, id: 'speaker-other-meeting' };
    await saveMeeting(meeting);
    await saveMeeting(other);
    const base = {
      meetingId: meeting.id,
      recordingId: 'speaker-recording',
      speakerLabel: '語者 A',
      track: 'upload' as const,
      text: 'original',
      translation: 'translation',
      startedAtMs: 1250,
      endedAtMs: 2500,
      isFinal: true,
    };
    const first = { ...base, id: 'speaker-first' };
    const second = { ...base, id: 'speaker-second' };
    const third = { ...base, id: 'speaker-third' };
    const unrelated = [
      { ...base, id: 'speaker-B', speakerLabel: '語者 B' },
      { ...base, id: 'speaker-other-file', recordingId: 'another-file' },
      { ...base, id: 'speaker-no-recording', recordingId: undefined },
    ];
    const differentMeeting = { ...base, id: 'speaker-other', meetingId: other.id };
    await saveSegments(meeting.id, [first, second, third, ...unrelated]);
    await saveSegment(differentMeeting);

    await expect(renameSegmentSpeaker(first, '   ', 'segment')).rejects.toThrow(
      'invalid speaker label',
    );
    expect(await renameSegmentSpeaker(first, ' 小林 ', 'segment')).toEqual([first.id]);
    expect((await listSegments(meeting.id)).find((item) => item.id === second.id)).toEqual(second);
    await expect(renameSegmentSpeaker(first, 'stale name', 'speaker')).rejects.toThrow(
      'speaker label has changed',
    );
    expect(await renameSegmentSpeaker(second, '陳小姐', 'speaker')).toEqual([second.id, third.id]);
    expect(await listSegments(meeting.id)).toEqual(
      expect.arrayContaining([
        { ...first, speakerLabel: '小林' },
        { ...second, speakerLabel: '陳小姐' },
        { ...third, speakerLabel: '陳小姐' },
        ...unrelated,
      ]),
    );
    expect(await listSegments(other.id)).toEqual([differentMeeting]);
  });

  it('scopes a batch rename of unlinked segments to the same meeting and excludes recordings', async () => {
    const meetingId = 'unlink-speaker-meeting';
    await saveMeeting({
      id: meetingId,
      title: 'Unlinked',
      createdAt: 1,
      notes: '',
      mode: '一般會議',
    });
    const first = {
      id: 'unlinked-1',
      meetingId,
      speakerLabel: '對方',
      track: 'system' as const,
      text: 'text',
      startedAtMs: 0,
      isFinal: false,
    };
    const second = { ...first, id: 'unlinked-2' };
    const recorded = { ...first, id: 'linked-1', recordingId: 'linked-recording' };
    await saveSegments(meetingId, [first, second, recorded]);
    expect(await renameSegmentSpeaker(first, '林先生', 'speaker')).toEqual([first.id, second.id]);
    expect(await listSegments(meetingId)).toEqual([
      recorded,
      { ...first, speakerLabel: '林先生' },
      { ...second, speakerLabel: '林先生' },
    ]);
  });

  it('orders segments by recording and then by offset', async () => {
    const meetingId = 'ordering-meeting';
    await saveMeeting({
      id: meetingId,
      title: 'Ordering',
      createdAt: 1,
      notes: '',
      mode: '一般會議',
    });
    await saveRecording({
      id: 'older',
      meetingId,
      createdAt: 10,
      mimeType: 'audio/webm',
      completed: true,
    });
    await saveRecording({
      id: 'newer',
      meetingId,
      createdAt: 20,
      mimeType: 'audio/webm',
      completed: true,
    });
    const base = {
      meetingId,
      track: 'mic' as const,
      speakerLabel: '我方',
      text: 'x',
      isFinal: true,
    };
    await saveSegment({ ...base, id: 'new-first', recordingId: 'newer', startedAtMs: 0 });
    await saveSegment({ ...base, id: 'old-second', recordingId: 'older', startedAtMs: 2000 });
    await saveSegment({ ...base, id: 'old-first', recordingId: 'older', startedAtMs: 1000 });
    expect((await listSegments(meetingId)).map((item) => item.id)).toEqual([
      'old-first',
      'old-second',
      'new-first',
    ]);
  });
});

const backupMeeting = {
  id: '46c51c87-44ad-4ac7-8f8d-2c675e39d152' as const,
  title: '雙語文字備份',
  notes: '工作筆記',
  createdAt: 20,
  mode: '雙語會議',
  sourceLang: '繁體中文',
  targetLang: 'English',
};
const backupRecording = {
  id: 'backup-recording',
  meetingId: backupMeeting.id,
  createdAt: 21,
  mimeType: 'audio/webm',
  completed: true,
  durationSeconds: 4,
};
const backupSegment: TranscriptSegment = {
  id: 'backup-segment',
  meetingId: backupMeeting.id,
  recordingId: backupRecording.id,
  track: 'upload',
  speakerLabel: '語者 A',
  speakerGroup: 'backup-speaker-group',
  startedAtMs: 30,
  endedAtMs: 900,
  text: '原文索引',
  translation: 'Translated index',
  isFinal: true,
};
const backupMinutes: MinutesRecord = {
  id: 'backup-minutes',
  meetingId: backupMeeting.id,
  createdAt: 22,
  action: 'polish',
  targetLanguage: '繁體中文',
  style: 'standard',
  markdownContent: '# Ｉｎｄｅｘ 摘要',
};

async function saveBackupFixture() {
  await saveMeeting(backupMeeting);
  await saveRecording(backupRecording);
  await saveSegment(backupSegment);
  await saveMinutes(backupMinutes);
  await saveAudioChunk(backupRecording.id, 2, new Blob(['second']));
  await saveAudioChunk(backupRecording.id, 0, new Blob(['first']));
}

describe('cross-meeting search', () => {
  it('finds persisted original text, translations, and minutes and reflects updates', async () => {
    await saveBackupFixture();
    expect((await searchMeetingContent(' 原文索引 ')).get(backupMeeting.id)).toEqual(
      new Set(['transcript']),
    );
    expect((await searchMeetingContent('INDEX')).get(backupMeeting.id)).toEqual(
      new Set(['translation', 'minutes']),
    );
    await updateSegmentTranslation(backupSegment.id, 'Revised translation');
    expect((await searchMeetingContent('index')).get(backupMeeting.id)).toEqual(
      new Set(['minutes']),
    );
    expect((await searchMeetingContent('revised')).get(backupMeeting.id)).toEqual(
      new Set(['translation']),
    );
    expect(await searchMeetingContent('  ')).toEqual(new Map());
  });
});

describe('meeting archives', () => {
  it('exports a single meeting and imports a copy with linked records and ordered audio', async () => {
    await saveBackupFixture();
    const file = await exportMeetingArchive({ meetingId: backupMeeting.id, includeAudio: true });
    const snapshot = await readMeetingArchive(file);
    expect(snapshot.meetings).toEqual([backupMeeting]);
    expect(snapshot.audioChunks.map(({ sequence }) => sequence)).toEqual([0, 2]);
    const [imported] = await importMeetingArchive(file);
    const [recording] = await listRecordings(imported.id);
    const [segment] = await listSegments(imported.id);
    const [minutes] = await listMinutes(imported.id);
    expect(imported.id).not.toBe(backupMeeting.id);
    expect(imported).toEqual({ ...backupMeeting, id: imported.id });
    expect(recording.id).not.toBe(backupRecording.id);
    expect(recording).toEqual({ ...backupRecording, id: recording.id, meetingId: imported.id });
    expect(segment.id).not.toBe(backupSegment.id);
    expect(segment).toEqual({
      ...backupSegment,
      id: segment.id,
      meetingId: imported.id,
      recordingId: recording.id,
    });
    expect(minutes.id).not.toBe(backupMinutes.id);
    expect(minutes).toEqual({ ...backupMinutes, id: minutes.id, meetingId: imported.id });
    expect(await (await getRecordingBlob(recording)).text()).toBe('firstsecond');
    expect(await listSegments(backupMeeting.id)).toEqual([backupSegment]);
  });

  it('round-trips the workspace without reading audio into the archive by default', async () => {
    await saveBackupFixture();
    const before = await listMeetings();
    const imported = await importMeetingArchive(await exportMeetingArchive());
    expect(imported.map(({ title }) => title).sort()).toEqual(
      before.map(({ title }) => title).sort(),
    );
    expect(await listMeetings()).toHaveLength(before.length * 2);
    const copy = imported.find(({ title }) => title === backupMeeting.title)!;
    const [recording] = await listRecordings(copy.id);
    expect((await listSegments(copy.id))[0].recordingId).toBe(recording.id);
    expect((await getRecordingBlob(recording)).size).toBe(0);
  });

  it('rejects malformed data, duplicate IDs, broken links, and truncated audio before writing', async () => {
    await saveBackupFixture();
    const before = await listMeetings();
    const file = await exportMeetingArchive({ meetingId: backupMeeting.id, includeAudio: true });
    const data = await readMeetingArchive(file);
    const invalidFiles = [
      new Blob(['not a backup']),
      file.slice(0, file.size - 1),
      buildMeetingArchive({ ...data, meetings: [...data.meetings, backupMeeting] }),
      buildMeetingArchive({ ...data, segments: [{ ...backupSegment, recordingId: 'missing' }] }),
      buildMeetingArchive({ ...data, minutes: [{ ...backupMinutes, createdAt: NaN }] }),
      buildMeetingArchive({ ...data, audioChunks: [data.audioChunks[0], data.audioChunks[0]] }),
    ];
    for (const invalid of invalidFiles)
      await expect(importMeetingArchive(invalid)).rejects.toThrow();
    expect(await listMeetings()).toEqual(before);
  });

  it('rolls back the whole import if a generated ID already exists', async () => {
    await saveBackupFixture();
    const file = await exportMeetingArchive({ meetingId: backupMeeting.id, includeAudio: true });
    const before = await listMeetings();
    const collision = vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(backupMeeting.id);
    try {
      await expect(importMeetingArchive(file)).rejects.toThrow();
    } finally {
      collision.mockRestore();
    }
    expect(await listMeetings()).toEqual(before);
    expect(await listRecordings(backupMeeting.id)).toEqual([backupRecording]);
  });
});

describe('meeting deletion', () => {
  it('removes related recordings, chunks, segments and minutes atomically', async () => {
    const { deleteMeeting, listMinutes, saveMinutes } = await import('../src/client/db/meetingDb');
    const meeting = { id: 'to-delete', title: 'Delete', createdAt: 3, notes: '', mode: '一般會議' };
    await saveMeeting(meeting);
    const recording = {
      id: 'delete-recording',
      meetingId: meeting.id,
      createdAt: 4,
      mimeType: 'audio/webm',
      completed: true,
    };
    const segment = {
      id: 'delete-segment',
      meetingId: meeting.id,
      track: 'mic' as const,
      speakerLabel: '我方',
      text: 'test',
      startedAtMs: 0,
      isFinal: true,
    };
    const minutes = {
      id: 'delete-minutes',
      meetingId: meeting.id,
      createdAt: 5,
      action: 'polish' as const,
      targetLanguage: 'English',
      style: 'standard' as const,
      markdownContent: 'test',
    };
    await saveRecording(recording);
    await saveAudioChunk(recording.id, 0, new Blob(['audio']));
    await saveSegment(segment);
    await saveMinutes(minutes);
    await deleteMeeting(meeting.id);
    expect((await listMeetings()).some((item) => item.id === meeting.id)).toBe(false);
    expect(await listRecordings(meeting.id)).toEqual([]);
    expect(await listSegments(meeting.id)).toEqual([]);
    expect(await listMinutes(meeting.id)).toEqual([]);
    expect((await getRecordingBlob(recording)).size).toBe(0);
    await expect(saveSegment(segment)).rejects.toThrow('meeting not found');
    await expect(saveMinutes(minutes)).rejects.toThrow('meeting not found');
  });

  it('atomically saves uploaded recording metadata and blob only when the meeting exists', async () => {
    const { saveUploadedRecording } = await import('../src/client/db/meetingDb');
    const meeting = {
      id: 'upload-atomic',
      title: 'Upload',
      createdAt: 10,
      notes: '',
      mode: '一般會議',
    };
    await saveMeeting(meeting);
    const rec = {
      id: 'upload-rec-1',
      meetingId: meeting.id,
      createdAt: 11,
      mimeType: 'audio/wav',
      filename: 'clip.wav',
      completed: false,
    };
    await saveUploadedRecording(rec, new Blob(['wave-bytes'], { type: 'audio/wav' }));
    expect(await listRecordings(meeting.id)).toEqual([{ ...rec, completed: true }]);
    expect(await (await getRecordingBlob(rec)).text()).toBe('wave-bytes');

    const missing = { ...rec, id: 'upload-rec-missing', meetingId: 'nonexistent-meeting' };
    await expect(saveUploadedRecording(missing, new Blob(['x']))).rejects.toThrow(
      'meeting not found',
    );
    expect(await listRecordings('nonexistent-meeting')).toEqual([]);
    expect((await getRecordingBlob(missing)).size).toBe(0);
  });
});
