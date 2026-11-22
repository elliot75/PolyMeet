import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { MinutesRecord, TranscriptSegment } from '../../shared/types';

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
interface AudioChunk {
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
}
export async function saveInterimSegment(segment: TranscriptSegment): Promise<void> {
  const tx = (await db()).transaction(['recordings', 'segments'], 'readwrite');
  const store = tx.objectStore('segments');
  const [recording, previous] = await Promise.all([
    segment.recordingId ? tx.objectStore('recordings').get(segment.recordingId) : undefined,
    store.get(segment.id),
  ]);
  if (recording?.meetingId === segment.meetingId && !previous?.isFinal)
    await store.put({ ...segment, isFinal: false });
  await tx.done;
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
): Promise<void> {
  const database = await db();
  const tx = database.transaction('segments', 'readwrite');
  const segment = await tx.store.get(id);
  if (segment && (isFinal || !segment.translation || segment.translationIsFinal === false))
    await tx.store.put({ ...segment, translation, translationIsFinal: isFinal });
  await tx.done;
}

export async function updateSegmentText(id: string, text: string): Promise<void> {
  const database = await db();
  const tx = database.transaction('segments', 'readwrite');
  const segment = await tx.store.get(id);
  if (segment) await tx.store.put({ ...segment, text });
  await tx.done;
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
}
