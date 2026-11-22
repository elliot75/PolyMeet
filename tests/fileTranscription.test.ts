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
  searchMeetingContent,
  subscribeToMeetingContent,
  updateSegmentText,
  updateSegmentTranslation,
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

  it('never bulk-renames the same provider label from a different transcription response', async () => {
    const { recording, options } = await setup();
    vi.stubGlobal('fetch', async () =>
      Response.json({
        segments: [
          { text: 'first', startSeconds: 0, endSeconds: 1, speaker: '語者 A' },
          { text: 'second', startSeconds: 1, endSeconds: 2, speaker: '語者 A' },
        ],
      }),
    );
    const initial = await transcribeSavedRecording(options);
    const appended = await transcribeSavedRecording(options);

    expect(new Set(await renameSegmentSpeaker(appended[0], 'Alice', 'speaker'))).toEqual(
      new Set(appended.map(({ id }) => id)),
    );
    const labels = new Map(
      (await listSegments(recording.meetingId)).map((s) => [s.id, s.speakerLabel]),
    );
    expect(initial.map((s) => labels.get(s.id))).toEqual(['語者 A', '語者 A']);
    expect(appended.map((s) => labels.get(s.id))).toEqual(['Alice', 'Alice']);
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

  it('refreshes meeting search when saved transcription and its translation are committed', async () => {
    const { recording, options } = await setup();
    vi.stubGlobal('fetch', async () => Response.json({ text: 'transcription search term' }));
    const changed = vi.fn();
    const unsubscribe = subscribeToMeetingContent(changed);
    try {
      const [segment] = await transcribeSavedRecording(options);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(
        (await searchMeetingContent('transcription search term')).get(recording.meetingId),
      ).toEqual(new Set(['transcript']));
      expect(await updateSegmentTranslation(segment.id, 'stale', true, 'old text')).toBe(false);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(await updateSegmentTranslation(segment.id, '譯文搜尋詞', true, segment.text)).toBe(
        true,
      );
      expect(changed).toHaveBeenCalledTimes(2);
      expect((await searchMeetingContent('譯文搜尋詞')).get(recording.meetingId)).toEqual(
        new Set(['translation']),
      );
    } finally {
      unsubscribe();
    }
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

  it('splits small long OpenAI files from either upload entry point when duration is unknown', async () => {
    const { recording, options } = await setup();
    const settings = { ...options.settings, sttProvider: 'openai' as const };
    vi.stubGlobal(
      'AudioContext',
      class {
        async decodeAudioData() {
          return { duration: 1250 };
        }
        async close() {}
      },
    );
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        destination = {};
        createBufferSource() {
          return { buffer: null, connect() {}, start() {} };
        }
        async startRendering() {
          return { getChannelData: () => new Float32Array(1) };
        }
      },
    );
    const uploadedParts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        uploadedParts.push(((init.body as FormData).get('file') as File).name);
        return Response.json({ text: 'sample' });
      }),
    );
    const upload = new File(['audio'], 'long.m4a', { type: 'audio/mp4' });
    const offsets: number[] = [];
    for await (const part of transcribeAudio(upload, { ...options, settings })) {
      offsets.push(part.segments[0].startedAtMs);
    }
    expect(offsets).toEqual([0, 600_000, 1_200_000]);
    const recovered = await transcribeSavedRecording({ ...options, settings, recording });
    expect(recovered.map(({ startedAtMs }) => startedAtMs)).toEqual(offsets);
    expect(uploadedParts).toEqual([
      'part-1.wav',
      'part-2.wav',
      'part-3.wav',
      'part-1.wav',
      'part-2.wav',
      'part-3.wav',
    ]);
  });

  it('surfaces auth_failed distinctly and normalizes missing MIME types on saved recordings', async () => {
    const { options, recording } = await setup();
    const m4aRec = {
      ...recording,
      id: crypto.randomUUID(),
      filename: 'voice-memo.m4a',
      mimeType: '',
    };
    await saveRecording(m4aRec);
    await saveAudioChunk(m4aRec.id, 0, new Blob(['audio-data']));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const sentFile = (init.body as FormData).get('file') as File;
        expect(sentFile.type).toBe('audio/mp4');
        return Response.json({ error: 'auth_failed' }, { status: 401 });
      }),
    );
    await expect(transcribeSavedRecording({ ...options, recording: m4aRec })).rejects.toThrow(
      'API 金鑰驗證失敗或無此模型權限，請檢查設定。',
    );
  });
});
