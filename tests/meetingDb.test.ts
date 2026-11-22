import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  getRecordingBlob,
  listMeetings,
  listRecordings,
  listSegments,
  migrateMeetings,
  saveAudioChunk,
  saveMeeting,
  saveRecording,
  saveSegment,
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
});
