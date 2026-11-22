import {
  MAX_SPEAKER_LABEL_LENGTH,
  type MinutesRecord,
  type TranscriptSegment,
} from '../../shared/types';
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
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;

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

function parseMeeting(value: unknown): Meeting {
  requireValid(
    isRecord(value) &&
      isId(value.id) &&
      isDate(value.createdAt) &&
      typeof value.title === 'string' &&
      typeof value.notes === 'string' &&
      (value.mode === '一般會議' || value.mode === '雙語會議') &&
      isOptionalString(value.sourceLang) &&
      isOptionalString(value.targetLang),
  );
  return {
    id: value.id,
    createdAt: value.createdAt,
    title: value.title,
    notes: value.notes,
    mode: value.mode,
    ...(value.sourceLang !== undefined ? { sourceLang: value.sourceLang } : {}),
    ...(value.targetLang !== undefined ? { targetLang: value.targetLang } : {}),
  };
}

function parseRecording(value: unknown): Recording {
  requireValid(
    isRecord(value) &&
      isId(value.id) &&
      isId(value.meetingId) &&
      isDate(value.createdAt) &&
      typeof value.mimeType === 'string' &&
      isOptionalString(value.filename) &&
      typeof value.completed === 'boolean' &&
      (value.durationSeconds === undefined || isNonnegative(value.durationSeconds)),
  );
  return {
    id: value.id,
    meetingId: value.meetingId,
    createdAt: value.createdAt,
    mimeType: value.mimeType,
    completed: value.completed,
    ...(value.filename !== undefined ? { filename: value.filename } : {}),
    ...(value.durationSeconds !== undefined ? { durationSeconds: value.durationSeconds } : {}),
  };
}

function parseSegment(value: unknown): TranscriptSegment {
  requireValid(
    isRecord(value) &&
      isId(value.id) &&
      isId(value.meetingId) &&
      (value.recordingId === undefined || isId(value.recordingId)) &&
      (value.track === 'mic' ||
        value.track === 'system' ||
        value.track === 'mixed' ||
        value.track === 'upload') &&
      typeof value.speakerLabel === 'string' &&
      value.speakerLabel.length <= MAX_SPEAKER_LABEL_LENGTH &&
      (value.speakerGroup === undefined || isId(value.speakerGroup)) &&
      isNonnegative(value.startedAtMs) &&
      (value.endedAtMs === undefined ||
        (isNonnegative(value.endedAtMs) && value.endedAtMs >= value.startedAtMs)) &&
      isOptionalBoolean(value.timeIsChunkStart) &&
      typeof value.text === 'string' &&
      isOptionalString(value.translation) &&
      isOptionalBoolean(value.translationIsFinal) &&
      typeof value.isFinal === 'boolean',
  );
  return {
    id: value.id,
    meetingId: value.meetingId,
    track: value.track,
    speakerLabel: value.speakerLabel,
    startedAtMs: value.startedAtMs,
    text: value.text,
    isFinal: value.isFinal,
    ...(value.recordingId !== undefined ? { recordingId: value.recordingId } : {}),
    ...(value.speakerGroup !== undefined ? { speakerGroup: value.speakerGroup } : {}),
    ...(value.endedAtMs !== undefined ? { endedAtMs: value.endedAtMs } : {}),
    ...(value.timeIsChunkStart !== undefined ? { timeIsChunkStart: value.timeIsChunkStart } : {}),
    ...(value.translation !== undefined ? { translation: value.translation } : {}),
    ...(value.translationIsFinal !== undefined
      ? { translationIsFinal: value.translationIsFinal }
      : {}),
  };
}

function parseMinutes(value: unknown): MinutesRecord {
  requireValid(
    isRecord(value) &&
      isId(value.id) &&
      isId(value.meetingId) &&
      isDate(value.createdAt) &&
      (value.action === 'polish' || value.action === 'translate_and_polish') &&
      (value.style === 'standard' ||
        value.style === 'action_items' ||
        value.style === 'detailed') &&
      typeof value.targetLanguage === 'string' &&
      typeof value.markdownContent === 'string',
  );
  return {
    id: value.id,
    meetingId: value.meetingId,
    createdAt: value.createdAt,
    action: value.action,
    style: value.style,
    targetLanguage: value.targetLanguage,
    markdownContent: value.markdownContent,
  };
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
  requireValid(manifestSize <= MAX_MANIFEST_BYTES && audioOffset <= file.size);
  let manifest: unknown;
  try {
    const bytes = await file.slice(headerSize, audioOffset).arrayBuffer();
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('無法讀取備份檔案。');
  }
  requireValid(isRecord(manifest));
  if (manifest.version !== 1) throw new Error('不支援此備份檔案版本。');
  const {
    meetings: rawMeetings,
    recordings: rawRecordings,
    segments: rawSegments,
    minutes: rawMinutes,
    audioChunks: descriptors,
  } = manifest;
  requireValid(Array.isArray(rawMeetings));
  requireValid(Array.isArray(rawRecordings));
  requireValid(Array.isArray(rawSegments));
  requireValid(Array.isArray(rawMinutes));
  requireValid(Array.isArray(descriptors));

  const meetings = rawMeetings.map(parseMeeting);
  const recordings = rawRecordings.map(parseRecording);
  const segments = rawSegments.map(parseSegment);
  const minutes = rawMinutes.map(parseMinutes);

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
