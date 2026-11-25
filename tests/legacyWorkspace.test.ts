import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import {
  getRecordingBlob,
  importLegacyWorkspace,
  listMeetings,
  listMinutes,
  listRecordings,
  listSegments,
  saveAudioChunk,
  saveMeeting,
  saveMinutes,
  saveRecording,
  saveSegment,
  setMeetingDbNamespace,
  type Meeting,
} from '../src/client/db/meetingDb';

it('copies the legacy workspace to the chosen account once while preserving the original data', async () => {
  const meeting: Meeting = {
    id: 'legacy',
    title: 'Legacy',
    mode: '一般會議',
    notes: '',
    createdAt: 1,
  };
  const recording = {
    id: 'rec',
    meetingId: meeting.id,
    createdAt: 1,
    mimeType: 'audio/wav',
    completed: true,
  };
  await saveMeeting(meeting);
  await saveRecording(recording);
  await saveAudioChunk(recording.id, 0, new Blob(['audio']));
  await saveSegment({
    id: 'part',
    meetingId: meeting.id,
    recordingId: recording.id,
    track: 'mic',
    speakerLabel: '我方',
    startedAtMs: 0,
    text: 'test',
    isFinal: true,
  });
  await saveMinutes({
    id: 'minutes',
    meetingId: meeting.id,
    createdAt: 1,
    action: 'polish',
    style: 'standard',
    targetLanguage: 'English',
    markdownContent: 'Notes',
  });

  setMeetingDbNamespace('target');
  expect(await listMeetings()).toEqual([]);
  await expect(importLegacyWorkspace('another')).rejects.toThrow('登入帳號已變更');
  expect(await importLegacyWorkspace('target')).toEqual([meeting]);
  expect(await listRecordings(meeting.id)).toEqual([recording]);
  expect(await (await getRecordingBlob(recording)).text()).toBe('audio');
  expect(await listSegments(meeting.id)).toMatchObject([{ id: 'part', recordingId: 'rec' }]);
  expect(await listMinutes(meeting.id)).toMatchObject([{ id: 'minutes' }]);

  await saveMeeting({ ...meeting, title: 'Edited' });
  expect(await importLegacyWorkspace('target')).toEqual([]);
  expect(await listMeetings()).toMatchObject([{ title: 'Edited' }]);
  setMeetingDbNamespace('different-account');
  await expect(importLegacyWorkspace('different-account')).rejects.toThrow('已綁定其他帳號');
  expect(await listMeetings()).toEqual([]);
  setMeetingDbNamespace(null);
  expect(await listMeetings()).toEqual([meeting]);
});
