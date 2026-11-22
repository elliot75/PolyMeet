import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  getRecordingBlob,
  listMeetings,
  listRecordings,
  listSegments,
  migrateMeetings,
  saveAudioChunk,
  saveInterimSegment,
  saveMeeting,
  saveRecording,
  saveSegment,
  saveSegments,
} from '../src/client/db/meetingDb';

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
