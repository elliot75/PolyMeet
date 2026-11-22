import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { MinutesRecord, TranscriptSegment } from '../../shared/types';
import { buildMeetingArchive, readMeetingArchive } from '../services/meetingArchive';

export interface Meeting {
  id: string;
  title: string;
  createdAt: number;
  notes: string;
  mode: string;
  sourceLang?: string;
  targetLang?: string;
}
export interface Recording {
  id: string;
  meetingId: string;
  createdAt: number;
  mimeType: string;
  filename?: string;
  completed: boolean;
  durationSeconds?: number;
}
export interface AudioChunk {
  recordingId: string;
  sequence: number;
  blob: Blob;
}
interface PolyMeetDB extends DBSchema {
  meetings: { key: string; value: Meeting };
  recordings: { key: string; value: Recording; indexes: { 'by-meeting': string } };
  audioChunks: { key: [string, number]; value: AudioChunk; indexes: { 'by-recording': string } };
  minutes: { key: string; value: MinutesRecord; indexes: { 'by-meeting': string } };
  segments: { key: string; value: TranscriptSegment; indexes: { 'by-meeting': string } };
}
let cached: Promise<IDBPDatabase<PolyMeetDB>> | undefined;
const db = () => {
  if (!cached) {
    let handle: IDBPDatabase<PolyMeetDB> | undefined;
    cached = openDB<PolyMeetDB>('polymeet', 3, {
      upgrade(database, oldVersion) {
        if (oldVersion < 1) {
          database.createObjectStore('meetings', { keyPath: 'id' });
          database
            .createObjectStore('recordings', { keyPath: 'id' })
            .createIndex('by-meeting', 'meetingId');
          database
            .createObjectStore('audioChunks', { keyPath: ['recordingId', 'sequence'] })
            .createIndex('by-recording', 'recordingId');
        }
        if (oldVersion < 2)
          database
            .createObjectStore('minutes', { keyPath: 'id' })
            .createIndex('by-meeting', 'meetingId');
        if (oldVersion < 3)
          database
            .createObjectStore('segments', { keyPath: 'id' })
            .createIndex('by-meeting', 'meetingId');
      },
      blocking() {
        handle?.close();
        cached = undefined;
      },
      terminated() {
        cached = undefined;
      },
    })
      .then((database) => {
        handle = database;
        return database;
      })
      .catch((error) => {
        cached = undefined;
        throw error;
      });
  }
  return cached;
};

export type MeetingSearchSource = 'transcript' | 'translation' | 'minutes';

const searchListeners = new Set<() => void>();

export function subscribeToMeetingContent(listener: () => void): () => void {
  searchListeners.add(listener);
  return () => searchListeners.delete(listener);
}

function notifyMeetingContentChanged() {
  searchListeners.forEach((listener) => listener());
}

export function normalizeMeetingQuery(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

export async function searchMeetingContent(
  query: string,
): Promise<Map<string, Set<MeetingSearchSource>>> {
  const matches = new Map<string, Set<MeetingSearchSource>>();
  const term = normalizeMeetingQuery(query);
  if (!term) return matches;

  const tx = (await db()).transaction(['segments', 'minutes']);
  const [segments, minutes] = await Promise.all([
    tx.objectStore('segments').getAll(),
    tx.objectStore('minutes').getAll(),
    tx.done,
  ]);
  function match(meetingId: string, source: MeetingSearchSource, text: string | undefined) {
    if (!text || matches.get(meetingId)?.has(source) || !normalizeMeetingQuery(text).includes(term))
      return;
    const sources = matches.get(meetingId) ?? new Set<MeetingSearchSource>();
    sources.add(source);
    matches.set(meetingId, sources);
  }
  for (const segment of segments) {
    match(segment.meetingId, 'transcript', segment.text);
    match(segment.meetingId, 'translation', segment.translation);
  }
  for (const record of minutes) match(record.meetingId, 'minutes', record.markdownContent);
  return matches;
}

export async function listMeetings(): Promise<Meeting[]> {
  return (await (await db()).getAll('meetings')).sort((a, b) => b.createdAt - a.createdAt);
}
export async function saveMeeting(meeting: Meeting): Promise<void> {
  await (await db()).put('meetings', meeting);
}
export async function migrateMeetings(meetings: Meeting[]): Promise<void> {
  const database = await db();
  const tx = database.transaction('meetings', 'readwrite');
  for (const meeting of meetings) {
    if (!(await tx.store.get(meeting.id))) await tx.store.put(meeting);
  }
  await tx.done;
}
export async function saveRecording(recording: Recording): Promise<void> {
  await (await db()).put('recordings', recording);
}
export async function saveAudioChunk(
  recordingId: string,
  sequence: number,
  blob: Blob,
): Promise<void> {
  await (await db()).put('audioChunks', { recordingId, sequence, blob });
}
export async function saveUploadedRecording(recording: Recording, file: Blob): Promise<void> {
  const tx = (await db()).transaction(['meetings', 'recordings', 'audioChunks'], 'readwrite');
  if (!(await tx.objectStore('meetings').get(recording.meetingId))) {
    await tx.done;
    throw new Error('meeting not found');
  }
  await tx.objectStore('recordings').put({ ...recording, completed: true });
  await tx.objectStore('audioChunks').put({ recordingId: recording.id, sequence: 0, blob: file });
  await tx.done;
}
export async function listRecordings(meetingId: string): Promise<Recording[]> {
  return (await (await db()).getAllFromIndex('recordings', 'by-meeting', meetingId)).sort(
    (a, b) => b.createdAt - a.createdAt,
  );
}
export async function getRecordingBlob(recording: Recording): Promise<Blob> {
  const chunks = await (await db()).getAllFromIndex('audioChunks', 'by-recording', recording.id);
  chunks.sort((a, b) => a.sequence - b.sequence);
  return new Blob(
    chunks.map((chunk) => chunk.blob),
    { type: recording.mimeType },
  );
}

export async function saveMinutes(record: MinutesRecord): Promise<void> {
  const tx = (await db()).transaction(['meetings', 'minutes'], 'readwrite');
  if (!(await tx.objectStore('meetings').get(record.meetingId))) {
    await tx.done;
    throw new Error('meeting not found');
  }
  await tx.objectStore('minutes').put(record);
  await tx.done;
  notifyMeetingContentChanged();
}
export async function listMinutes(meetingId: string): Promise<MinutesRecord[]> {
  return (await (await db()).getAllFromIndex('minutes', 'by-meeting', meetingId)).sort(
    (a, b) => b.createdAt - a.createdAt,
  );
}
export async function saveSegment(segment: TranscriptSegment): Promise<void> {
  await saveSegments(segment.meetingId, [segment]);
}
export async function saveSegments(
  meetingId: string,
  segments: TranscriptSegment[],
): Promise<void> {
  if (!segments.length) return;
  const tx = (await db()).transaction(['meetings', 'segments'], 'readwrite');
  if (!(await tx.objectStore('meetings').get(meetingId))) {
    await tx.done;
    throw new Error('meeting not found');
  }
  const store = tx.objectStore('segments');
  try {
    // Queue all writes in the same transaction so a partially saved part can be retried.
    await Promise.all([tx.done, ...segments.map(async (segment) => store.put(segment))]);
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // IndexedDB may have already aborted the transaction.
    }
    await tx.done.catch(() => {});
    throw error;
  }
  notifyMeetingContentChanged();
}
export async function saveRecordingSegments(
  recording: Recording,
  segments: TranscriptSegment[],
  previous?: TranscriptSegment[],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!segments.length) return;
  const database = await db();
  signal?.throwIfAborted();
  const tx = database.transaction(['recordings', 'segments'], 'readwrite');
  const store = tx.objectStore('segments');
  const abort = () => {
    try {
      tx.abort();
    } catch {
      // The transaction may have already finished.
    }
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const saved = await tx.objectStore('recordings').get(recording.id);
    if (saved?.meetingId !== recording.meetingId)
      throw new Error('此錄音已不存在，請重新開啟會議。');
    if (previous) {
      const current = (await store.index('by-meeting').getAll(recording.meetingId)).filter(
        (segment) => segment.recordingId === recording.id,
      );
      const expected = new Map(previous.map((segment) => [segment.id, segment]));
      if (
        current.length !== previous.length ||
        current.some((segment) => {
          const snapshot = expected.get(segment.id);
          return (
            snapshot?.text !== segment.text ||
            snapshot.isFinal !== segment.isFinal ||
            snapshot.speakerLabel !== segment.speakerLabel
          );
        })
      ) {
        throw new Error('此錄音的逐字稿已有變更，請關閉視窗後重新確認。');
      }
    }
    await Promise.all([
      tx.done,
      ...(previous ?? []).map(async (segment) => store.delete(segment.id)),
      ...segments.map(async (segment) => store.add(segment)),
    ]);
  } catch (error) {
    abort();
    await tx.done.catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  notifyMeetingContentChanged();
}

export async function saveInterimSegment(segment: TranscriptSegment): Promise<void> {
  const tx = (await db()).transaction(['recordings', 'segments'], 'readwrite');
  const store = tx.objectStore('segments');
  const [recording, previous] = await Promise.all([
    segment.recordingId ? tx.objectStore('recordings').get(segment.recordingId) : undefined,
    store.get(segment.id),
  ]);
  const shouldSave = recording?.meetingId === segment.meetingId && !previous?.isFinal;
  if (shouldSave) await store.put({ ...segment, isFinal: false });
  await tx.done;
  if (shouldSave) notifyMeetingContentChanged();
}

export async function listSegments(meetingId: string): Promise<TranscriptSegment[]> {
  const database = await db();
  const [segments, recordings] = await Promise.all([
    database.getAllFromIndex('segments', 'by-meeting', meetingId),
    database.getAllFromIndex('recordings', 'by-meeting', meetingId),
  ]);
  const starts = new Map(recordings.map((recording) => [recording.id, recording.createdAt]));
  return segments.sort(
    (a, b) =>
      (starts.get(a.recordingId || '') || 0) - (starts.get(b.recordingId || '') || 0) ||
      a.startedAtMs - b.startedAtMs,
  );
}

export async function updateSegmentTranslation(
  id: string,
  translation: string,
  isFinal = true,
  expectedText?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const database = await db();
  const tx = database.transaction('segments', 'readwrite');
  const segment = await tx.store.get(id);
  const canUpdate =
    !!segment &&
    !signal?.aborted &&
    (expectedText === undefined || segment.text === expectedText) &&
    (isFinal || !segment.translation || segment.translationIsFinal === false);
  if (canUpdate) await tx.store.put({ ...segment, translation, translationIsFinal: isFinal });
  await tx.done;
  if (canUpdate) notifyMeetingContentChanged();
  return canUpdate;
}

export async function updateSegmentText(id: string, text: string): Promise<void> {
  const database = await db();
  const tx = database.transaction('segments', 'readwrite');
  const segment = await tx.store.get(id);
  const changed = segment && segment.text !== text;
  if (changed)
    await tx.store.put({ ...segment, text, translation: undefined, translationIsFinal: undefined });
  await tx.done;
  if (changed) notifyMeetingContentChanged();
}

const archiveStores = ['meetings', 'recordings', 'audioChunks', 'segments', 'minutes'] as const;

export async function exportMeetingArchive({
  meetingId,
  includeAudio = false,
}: { meetingId?: string; includeAudio?: boolean } = {}): Promise<Blob> {
  const tx = (await db()).transaction(archiveStores);
  const recordingsStore = tx.objectStore('recordings');
  const segmentsStore = tx.objectStore('segments');
  const minutesStore = tx.objectStore('minutes');
  const chunksStore = tx.objectStore('audioChunks');
  const recordingsRequest = recordingsStore.index('by-meeting').getAll(meetingId);
  const chunksRequest = includeAudio
    ? recordingsRequest.then(async (recordings) => {
        const byRecording = await Promise.all(
          recordings.map(({ id }) => chunksStore.index('by-recording').getAll(id)),
        );
        return byRecording.flat();
      })
    : [];
  const [meetings, recordings, segments, minutes, audioChunks] = await Promise.all([
    tx.objectStore('meetings').getAll(meetingId),
    recordingsRequest,
    segmentsStore.index('by-meeting').getAll(meetingId),
    minutesStore.index('by-meeting').getAll(meetingId),
    chunksRequest,
    tx.done,
  ]);
  if (meetingId !== undefined && meetings.length === 0) throw new Error('找不到要備份的會議。');

  const meetingIds = new Set(meetings.map(({ id }) => id));
  const savedRecordings = recordings.filter((item) => meetingIds.has(item.meetingId));
  const recordingOwners = new Map(savedRecordings.map(({ id, meetingId }) => [id, meetingId]));
  return buildMeetingArchive({
    meetings,
    recordings: savedRecordings,
    segments: segments
      .filter((item) => meetingIds.has(item.meetingId))
      .map((item) =>
        item.recordingId && recordingOwners.get(item.recordingId) !== item.meetingId
          ? { ...item, recordingId: undefined }
          : item,
      ),
    minutes: minutes.filter((item) => meetingIds.has(item.meetingId)),
    audioChunks: audioChunks.filter((item) => recordingOwners.has(item.recordingId)),
  });
}

export async function importMeetingArchive(file: Blob): Promise<Meeting[]> {
  const archive = await readMeetingArchive(file);
  const meetingIds = new Map(archive.meetings.map(({ id }) => [id, crypto.randomUUID()]));
  const recordingIds = new Map(archive.recordings.map(({ id }) => [id, crypto.randomUUID()]));
  const meetings = archive.meetings.map((item) => ({ ...item, id: meetingIds.get(item.id)! }));
  const tx = (await db()).transaction(archiveStores, 'readwrite');
  try {
    await Promise.all([
      tx.done,
      ...meetings.map(async (item) => tx.objectStore('meetings').add(item)),
      ...archive.recordings.map(async (item) =>
        tx.objectStore('recordings').add({
          ...item,
          id: recordingIds.get(item.id)!,
          meetingId: meetingIds.get(item.meetingId)!,
        }),
      ),
      ...archive.segments.map(async (item) =>
        tx.objectStore('segments').add({
          ...item,
          id: crypto.randomUUID(),
          meetingId: meetingIds.get(item.meetingId)!,
          recordingId: item.recordingId ? recordingIds.get(item.recordingId)! : undefined,
        }),
      ),
      ...archive.minutes.map(async (item) =>
        tx.objectStore('minutes').add({
          ...item,
          id: crypto.randomUUID(),
          meetingId: meetingIds.get(item.meetingId)!,
        }),
      ),
      ...archive.audioChunks.map(async (item) =>
        tx.objectStore('audioChunks').add({
          ...item,
          recordingId: recordingIds.get(item.recordingId)!,
        }),
      ),
    ]);
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // IndexedDB may have already aborted the transaction.
    }
    await tx.done.catch(() => {});
    throw error;
  }
  notifyMeetingContentChanged();
  return meetings.sort((a, b) => b.createdAt - a.createdAt);
}

export const MAX_SPEAKER_LABEL_LENGTH = 100;

export async function renameSegmentSpeaker(
  segment: Pick<TranscriptSegment, 'id' | 'meetingId' | 'speakerLabel'>,
  name: string,
  scope: 'segment' | 'speaker',
): Promise<string[]> {
  const speakerLabel = name.trim();
  if (!speakerLabel || speakerLabel.length > MAX_SPEAKER_LABEL_LENGTH)
    throw new Error('invalid speaker label');

  const tx = (await db()).transaction('segments', 'readwrite');
  const current = await tx.store.get(segment.id);
  if (current?.meetingId !== segment.meetingId || current.speakerLabel !== segment.speakerLabel) {
    await tx.done;
    throw new Error('speaker label has changed or segment no longer exists');
  }
  const matches =
    scope === 'segment'
      ? [current]
      : (await tx.store.index('by-meeting').getAll(current.meetingId)).filter(
          (item) =>
            item.recordingId === current.recordingId && item.speakerLabel === current.speakerLabel,
        );
  await Promise.all([tx.done, ...matches.map((item) => tx.store.put({ ...item, speakerLabel }))]);
  return matches.map((item) => item.id);
}

export async function deleteMeeting(meetingId: string): Promise<void> {
  const tx = (await db()).transaction(
    ['meetings', 'recordings', 'audioChunks', 'segments', 'minutes'],
    'readwrite',
  );
  const recordingIds = await tx.objectStore('recordings').index('by-meeting').getAllKeys(meetingId);
  const segmentIds = await tx.objectStore('segments').index('by-meeting').getAllKeys(meetingId);
  const minuteIds = await tx.objectStore('minutes').index('by-meeting').getAllKeys(meetingId);
  for (const id of recordingIds) {
    const keys = await tx.objectStore('audioChunks').index('by-recording').getAllKeys(id);
    for (const key of keys) await tx.objectStore('audioChunks').delete(key);
    await tx.objectStore('recordings').delete(id);
  }
  for (const id of segmentIds) await tx.objectStore('segments').delete(id);
  for (const id of minuteIds) await tx.objectStore('minutes').delete(id);
  await tx.objectStore('meetings').delete(meetingId);
  await tx.done;
  notifyMeetingContentChanged();
}
