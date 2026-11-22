import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listRecordings,
  listSegments,
  renameSegmentSpeaker,
  saveAudioChunk,
  saveMeeting,
  saveRecording,
  saveRecordingSegments,
  saveSegment,
  saveUploadedRecording,
  updateSegmentText,
} from '../src/client/db/meetingDb';
import {
  transcribeAudio,
  transcribeSavedRecording,
} from '../src/client/services/fileTranscription';
import { defaults } from '../src/client/services/settings';
import type { TranscriptSegment } from '../src/shared/types';

async function setup() {
  const meetingId = crypto.randomUUID();
  const recording = {
    id: crypto.randomUUID(),
    meetingId,
    createdAt: 2,
    completed: false,
    mimeType: 'audio/webm;codecs=opus',
  };
  await saveMeeting({ id: meetingId, title: 'Test', createdAt: 1, notes: '', mode: '雙語會議' });
  await saveRecording(recording);
  await saveAudioChunk(recording.id, 1, new Blob(['second']));
  await saveAudioChunk(recording.id, 0, new Blob(['first']));
  const previous: TranscriptSegment = {
    id: crypto.randomUUID(),
    meetingId,
    recordingId: recording.id,
    track: 'mic',
    speakerLabel: '我方',
    startedAtMs: 0,
    text: 'previous',
    translation: 'prior translation',
    isFinal: false,
  };
  await saveSegment(previous);
  const controller = new AbortController();
  const options = {
    recording,
    settings: { ...defaults, sttProvider: 'gemini' as const },
    languageHints: ['zh-TW', 'en-US'],
    signal: controller.signal,
    onPartStart: vi.fn(),
    onPartComplete: vi.fn(),
  };
  return { recording, previous, options, controller };
}

afterEach(() => vi.unstubAllGlobals());

describe('file and saved recording transcription', () => {
  it('appends to an interrupted recording with ordered audio and recording-relative timestamps', async () => {
    const { recording, previous, options } = await setup();
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('/api/transcribe-file');
      expect(init.signal).toBe(options.signal);
      const form = init.body as FormData;
      expect(form.get('provider')).toBe('gemini');
      expect(form.get('model')).toBe(defaults.geminiSttModel);
      expect(form.getAll('language')).toEqual(['zh-TW', 'en-US']);
      const file = form.get('file') as File;
      expect(file.name.endsWith('.webm')).toBe(true);
      expect(file.type).toBe(recording.mimeType);
      expect(await file.text()).toBe('firstsecond');
      return Response.json({
        segments: [{ text: 'new', startSeconds: 1.25, endSeconds: 1.75, speaker: '語者 A' }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const added = await transcribeSavedRecording(options);

    expect(added).toMatchObject([
      {
        recordingId: recording.id,
        startedAtMs: 1250,
        endedAtMs: 1750,
        speakerLabel: '語者 A',
        isFinal: true,
      },
    ]);
    expect(await listSegments(recording.meetingId)).toEqual([previous, ...added]);
    expect(await listRecordings(recording.meetingId)).toEqual([recording]);
    expect(options.onPartStart).toHaveBeenCalledWith(1, 1);
    expect(options.onPartComplete).toHaveBeenCalledWith(1, false);
  });

  it('replaces only the selected recording’s transcript once new speech is saved', async () => {
    const { recording, previous, options } = await setup();
    const otherRecording = { ...recording, id: crypto.randomUUID(), createdAt: 3 };
    const otherSegment = { ...previous, id: crypto.randomUUID(), recordingId: otherRecording.id };
    await saveRecording(otherRecording);
    await saveSegment(otherSegment);
    const provider = vi.fn(async () => Response.json({ segments: [] }));
    vi.stubGlobal('fetch', provider);
    expect(await transcribeSavedRecording(options, [previous])).toEqual([]);
    expect(await listSegments(recording.meetingId)).toEqual([previous, otherSegment]);

    provider.mockResolvedValueOnce(Response.json({ text: 'new transcript' }));
    const added = await transcribeSavedRecording(options, [previous]);
    expect(added).toMatchObject([
      { text: 'new transcript', startedAtMs: 0, timeIsChunkStart: true },
    ]);
    expect(await listSegments(recording.meetingId)).toEqual([...added, otherSegment]);
  });

  it.each(['cancel', 'error', 'concurrent edit'])('keeps prior segments on %s', async (reason) => {
    const { recording, previous, options, controller } = await setup();
    const provider = vi.fn(async () => {
      if (reason === 'error')
        return Response.json({ error: 'provider_request_failed' }, { status: 502 });
      if (reason === 'concurrent edit') await updateSegmentText(previous.id, 'edited');
      return Response.json({ text: 'new transcript' });
    });
    vi.stubGlobal('fetch', provider);
    // Cancel after a result arrives, before any replacement writes can commit.
    if (reason === 'cancel') options.onPartComplete.mockImplementation(() => controller.abort());

    await expect(transcribeSavedRecording(options, [previous])).rejects.toThrow();
    const segments = await listSegments(recording.meetingId);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      id: previous.id,
      text: reason === 'concurrent edit' ? 'edited' : previous.text,
    });
  });

  it('keeps a speaker rename made while transcription is replacing an existing transcript', async () => {
    const { recording, previous, options } = await setup();
    vi.stubGlobal('fetch', async () => {
      await renameSegmentSpeaker(previous, 'Alice', 'segment');
      return Response.json({ text: 'new transcript' });
    });

    await expect(transcribeSavedRecording(options, [previous])).rejects.toThrow();
    expect(await listSegments(recording.meetingId)).toEqual([
      { ...previous, speakerLabel: 'Alice' },
    ]);
  });

  it('rolls back deletion when the replacement encounters a storage conflict', async () => {
    const { recording, previous } = await setup();
    const added = { ...previous, id: crypto.randomUUID(), text: 'new' };
    await expect(saveRecordingSegments(recording, [added, added], [previous])).rejects.toThrow();
    expect(await listSegments(recording.meetingId)).toEqual([previous]);
  });

  it('uses the same transcription pipeline for a newly uploaded recording', async () => {
    const { recording, options } = await setup();
    const file = new File(['new file'], 'uploaded.wav', { type: 'audio/wav' });
    const upload = {
      ...recording,
      id: crypto.randomUUID(),
      filename: file.name,
      mimeType: file.type,
      completed: true,
    };
    await saveUploadedRecording(upload, file);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ text: 'upload transcript' })),
    );
    for await (const part of transcribeAudio(file, { ...options, recording: upload })) {
      await saveRecordingSegments(upload, part.segments);
    }
    expect(await listSegments(recording.meetingId)).toContainEqual(
      expect.objectContaining({ recordingId: upload.id, text: 'upload transcript', isFinal: true }),
    );
    expect(await listRecordings(recording.meetingId)).toHaveLength(2);
  });
});
