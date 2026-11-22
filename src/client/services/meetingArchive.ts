import type { MinutesRecord, TranscriptSegment } from '../../shared/types';
import type { AudioChunk, Meeting, Recording } from '../db/meetingDb';

export interface MeetingArchiveData {
  meetings: Meeting[];
  recordings: Recording[];
  segments: TranscriptSegment[];
  minutes: MinutesRecord[];
  audioChunks: AudioChunk[];
}

const signature = new TextEncoder().encode('PolyMeet\n');
const headerSize = signature.length + 4;

// A versioned JSON manifest is followed by the raw audio bytes in manifest order.
export function buildMeetingArchive(data: MeetingArchiveData): Blob {
  const { audioChunks, ...records } = data;
  const manifest = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      ...records,
      audioChunks: audioChunks.map(({ recordingId, sequence, blob }) => ({
        recordingId,
        sequence,
        byteLength: blob.size,
        mimeType: blob.type,
      })),
    }),
  );
  const header = new Uint8Array(headerSize);
  header.set(signature);
  new DataView(header.buffer).setUint32(signature.length, manifest.byteLength);
  return new Blob([header, manifest, ...audioChunks.map(({ blob }) => blob)], {
    type: 'application/octet-stream',
  });
}

function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('備份檔案損毀或格式不符。');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isDate(value: unknown): value is number {
  return typeof value === 'number' && Math.abs(value) <= 8_640_000_000_000_000;
}

function isNonnegative(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isMeeting(value: unknown): value is Meeting {
  return (
    isRecord(value) &&
    isId(value.id) &&
    isDate(value.createdAt) &&
    typeof value.title === 'string' &&
    typeof value.notes === 'string' &&
    typeof value.mode === 'string' &&
    isOptionalString(value.sourceLang) &&
    isOptionalString(value.targetLang)
  );
}

function isRecording(value: unknown): value is Recording {
  return (
    isRecord(value) &&
    isId(value.id) &&
    isId(value.meetingId) &&
    isDate(value.createdAt) &&
    typeof value.mimeType === 'string' &&
    isOptionalString(value.filename) &&
    typeof value.completed === 'boolean' &&
    (value.durationSeconds === undefined || isNonnegative(value.durationSeconds))
  );
}

function isSegment(value: unknown): value is TranscriptSegment {
  return (
    isRecord(value) &&
    isId(value.id) &&
    isId(value.meetingId) &&
    (value.recordingId === undefined || isId(value.recordingId)) &&
    (value.track === 'mic' ||
      value.track === 'system' ||
      value.track === 'mixed' ||
      value.track === 'upload') &&
    typeof value.speakerLabel === 'string' &&
    (value.speakerGroup === undefined || isId(value.speakerGroup)) &&
    isNonnegative(value.startedAtMs) &&
    (value.endedAtMs === undefined || isNonnegative(value.endedAtMs)) &&
    isOptionalBoolean(value.timeIsChunkStart) &&
    typeof value.text === 'string' &&
    isOptionalString(value.translation) &&
    isOptionalBoolean(value.translationIsFinal) &&
    typeof value.isFinal === 'boolean'
  );
}

function isMinutes(value: unknown): value is MinutesRecord {
  return (
    isRecord(value) &&
    isId(value.id) &&
    isId(value.meetingId) &&
    isDate(value.createdAt) &&
    (value.action === 'polish' || value.action === 'translate_and_polish') &&
    (value.style === 'standard' || value.style === 'action_items' || value.style === 'detailed') &&
    typeof value.targetLanguage === 'string' &&
    typeof value.markdownContent === 'string'
  );
}

function recordsById<T extends { id: string }>(records: T[]): Map<string, T> {
  const byId = new Map(records.map((record) => [record.id, record]));
  requireValid(byId.size === records.length);
  return byId;
}

export async function readMeetingArchive(file: Blob): Promise<MeetingArchiveData> {
  const header = new Uint8Array(await file.slice(0, headerSize).arrayBuffer());
  requireValid(
    header.length === headerSize && signature.every((byte, index) => byte === header[index]),
  );
  const manifestSize = new DataView(header.buffer).getUint32(signature.length);
  let audioOffset = headerSize + manifestSize;
  requireValid(audioOffset <= file.size);
  let manifest: unknown;
  try {
    const bytes = await file.slice(headerSize, audioOffset).arrayBuffer();
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('無法讀取備份檔案。');
  }
  requireValid(isRecord(manifest));
  if (manifest.version !== 1) throw new Error('不支援此備份檔案版本。');
  const { meetings, recordings, segments, minutes, audioChunks: descriptors } = manifest;
  requireValid(Array.isArray(meetings) && meetings.every(isMeeting));
  requireValid(Array.isArray(recordings) && recordings.every(isRecording));
  requireValid(Array.isArray(segments) && segments.every(isSegment));
  requireValid(Array.isArray(minutes) && minutes.every(isMinutes));
  requireValid(Array.isArray(descriptors));

  const meetingIds = recordsById(meetings);
  const recordingIds = recordsById(recordings);
  recordsById(segments);
  recordsById(minutes);
  requireValid(recordings.every((item) => meetingIds.has(item.meetingId)));
  requireValid(minutes.every((item) => meetingIds.has(item.meetingId)));
  requireValid(
    segments.every(
      (item) =>
        meetingIds.has(item.meetingId) &&
        (item.recordingId === undefined ||
          recordingIds.get(item.recordingId)?.meetingId === item.meetingId),
    ),
  );

  const chunkKeys = new Set<string>();
  const audioChunks = descriptors.map((descriptor): AudioChunk => {
    requireValid(isRecord(descriptor));
    const { recordingId, sequence, byteLength, mimeType } = descriptor;
    requireValid(isId(recordingId) && recordingIds.has(recordingId));
    requireValid(isNonnegative(sequence) && Number.isSafeInteger(sequence));
    requireValid(isNonnegative(byteLength) && Number.isSafeInteger(byteLength));
    requireValid(typeof mimeType === 'string' && byteLength <= file.size - audioOffset);
    const key = JSON.stringify([recordingId, sequence]);
    requireValid(!chunkKeys.has(key));
    chunkKeys.add(key);
    const blob = file.slice(audioOffset, audioOffset + byteLength, mimeType);
    audioOffset += byteLength;
    return { recordingId, sequence, blob };
  });
  requireValid(audioOffset === file.size);
  return { meetings, recordings, segments, minutes, audioChunks };
}
