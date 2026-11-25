import type { UsageTimeInterval } from '../../shared/types';
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { LiveCapture } from '../audio/liveCapture';
import { startLocalAudioMeter, type AudioLevels } from '../audio/localAudioMeter';
import { SegmentTimeline } from '../audio/segmentTimeline';
import {
  deleteInterimSegment,
  listRecordings,
  listSegments,
  saveAudioChunk,
  saveInterimSegment,
  saveRecording,
  saveSegment,
  type Meeting,
  type Recording,
} from '../db/meetingDb';
import type { Settings } from '../services/settings';
import { languageCode } from '../../shared/languages';
import type { AudioTrackRole, TranscriptSegment } from '../../shared/types';

export type LevelSubscriber = (levels: AudioLevels) => void;

const AUDIO_SLICE_MS = 1000;
const INTERIM_SAVE_INTERVAL_MS = 600;

function checkpointAudio(recorder: MediaRecorder | null) {
  if (!recorder || recorder.state === 'inactive') return;
  try {
    recorder.requestData();
  } catch {
    // Stopping may race with a visibility or pause checkpoint.
  }
}

export interface UseRecordingSessionOptions {
  meeting: Meeting | undefined;
  source: 'mic' | 'both';
  liveEnabled: boolean;
  settings: Settings;
  uploading: boolean;
  generating: boolean;
  selectedRef: MutableRefObject<string | null>;
  onError: (message: string) => void;
  onTranslationStatus: (message: string) => void;
  onAppendSegment: (recording: Recording, segment: TranscriptSegment) => void;
  onEnqueueTranslation: (segments: TranscriptSegment[]) => void;
  onDraftsRecovered: (recording: Recording, drafts: TranscriptSegment[]) => void;
  onRecordingsUpdated: (meetingId: string, recordings: Recording[]) => void;
  onFinishTranslationsForReload: () => Promise<void>;
  onFlushAll: () => Promise<boolean>;
  onActiveUsageSessionChange?: (usageSessionId: string | null) => void;
  onRecordingComplete?: (info: {
    usageSessionId: string;
    meetingId: string;
    meetingTitle: string;
    startedAt: number;
    endedAt: number;
    durationSeconds: number;
    activeIntervals: UsageTimeInterval[];
    isReload: boolean;
  }) => void | Promise<void>;
}

export function useRecordingSession(options: UseRecordingSessionOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [recording, setRecording] = useState(false);
  const [savingRecording, setSavingRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [liveStatus, setLiveStatus] = useState('');
  const [interims, setInterims] = useState<Record<string, { track: AudioTrackRole; text: string }>>(
    {},
  );

  const recorder = useRef<MediaRecorder | null>(null);
  const recordingSettled = useRef<Promise<boolean> | null>(null);
  const reloadRequested = useRef(false);
  const allowSavedReload = useRef(false);
  const streams = useRef<MediaStream[]>([]);
  const liveCapture = useRef<LiveCapture | null>(null);
  const stopLocalMeter = useRef<(() => void) | undefined>(undefined);
  const mixContext = useRef<AudioContext | null>(null);
  const flushInterimsRef = useRef<(() => void) | null>(null);
  const recordingClockRef = useRef({ startedAtMs: 0, pausedAccumMs: 0, pausedAtMs: 0 });
  const levelSubscribersRef = useRef(new Set<LevelSubscriber>());
  const levelsRef = useRef<AudioLevels>({ mic: 0, system: 0 });

  const subscribeLevels = useCallback((listener: LevelSubscriber) => {
    levelSubscribersRef.current.add(listener);
    listener(levelsRef.current);
    return () => {
      levelSubscribersRef.current.delete(listener);
    };
  }, []);

  const publishLevels = useCallback((next: AudioLevels) => {
    levelsRef.current = next;
    for (const listener of levelSubscribersRef.current) listener(next);
  }, []);

  useEffect(() => {
    return () => {
      flushInterimsRef.current?.();
      flushInterimsRef.current = null;
      void liveCapture.current?.stop().catch(() => {});
      stopLocalMeter.current?.();
      stopLocalMeter.current = undefined;
      streams.current.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
      if (mixContext.current?.state !== 'closed') void mixContext.current?.close().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!recording || paused) return;
    const updateClock = () => {
      const clock = recordingClockRef.current;
      if (!clock.startedAtMs) return;
      setElapsed(
        Math.max(0, Math.floor((Date.now() - clock.startedAtMs - clock.pausedAccumMs) / 1000)),
      );
    };
    updateClock();
    const timer = window.setInterval(updateClock, 500);
    return () => window.clearInterval(timer);
  }, [recording, paused]);

  useEffect(() => {
    if (!recording && !savingRecording) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (allowSavedReload.current) return;
      event.preventDefault();
      event.returnValue = ' ';
    };
    const checkpoint = () => {
      flushInterimsRef.current?.();
      checkpointAudio(recorder.current);
    };
    const saveOnHidden = () => {
      if (document.visibilityState === 'hidden') checkpoint();
    };
    window.addEventListener('beforeunload', warn);
    window.addEventListener('pagehide', checkpoint);
    document.addEventListener('visibilitychange', saveOnHidden);
    return () => {
      window.removeEventListener('beforeunload', warn);
      window.removeEventListener('pagehide', checkpoint);
      document.removeEventListener('visibilitychange', saveOnHidden);
    };
  }, [recording, savingRecording]);

  const start = useCallback(async () => {
    const {
      meeting,
      source,
      liveEnabled,
      settings,
      uploading,
      generating,
      selectedRef,
      onError,
      onTranslationStatus,
      onAppendSegment,
      onEnqueueTranslation,
      onDraftsRecovered,
      onRecordingsUpdated,
      onFinishTranslationsForReload,
    } = optionsRef.current;

    if (!meeting || busy || uploading || generating) return;
    if (
      meeting.mode === '雙語會議' &&
      (meeting.sourceLang || '繁體中文') === (meeting.targetLang || 'English')
    ) {
      onError('請選擇兩種不同的語言。');
      return;
    }
    setBusy(true);
    onError('');
    setElapsed(0);
    setInterims({});
    setLiveStatus('');
    onTranslationStatus('');
    publishLevels({ mic: 0, system: 0 });
    let mic: MediaStream | undefined, display: MediaStream | undefined;
    let mixer: AudioContext | undefined, live: LiveCapture | undefined;
    try {
      if (source === 'both') {
        display = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { suppressLocalAudioPlayback: false },
        } as DisplayMediaStreamOptions);
        if (!display.getAudioTracks().length)
          throw new Error('未選擇可分享的音訊，請重新選擇分頁並啟用分享音訊。');
        display.getVideoTracks().forEach((track) => {
          track.enabled = false;
        });
      }
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      streams.current = [mic, ...(display ? [display] : [])];
      let recordingStream = mic;
      if (display) {
        mixer = new AudioContext();
        if (mixer.state === 'suspended') await mixer.resume();
        mixContext.current = mixer;
        const merger = mixer.createChannelMerger(2),
          destination = mixer.createMediaStreamDestination();
        mixer.createMediaStreamSource(mic).connect(merger, 0, 0);
        mixer.createMediaStreamSource(display).connect(merger, 0, 1);
        merger.connect(destination);
        recordingStream = destination.stream;
      }
      const r = new MediaRecorder(recordingStream);
      const startMeter = (micStream: MediaStream) => {
        try {
          stopLocalMeter.current = startLocalAudioMeter(
            { mic: micStream, system: display },
            () => r.state === 'recording',
            publishLevels,
            mixer,
          );
        } catch {
          // Metering is optional and must not prevent local recording.
        }
      };
      const saved: Recording = {
        id: crypto.randomUUID(),
        meetingId: meeting.id,
        createdAt: Date.now(),
        mimeType: r.mimeType || 'audio/webm',
        completed: false,
      };
      let startedAt = Date.now(),
        pausedAt = 0,
        pausedDuration = 0;
      const activeIntervals: UsageTimeInterval[] = [];
      let activeSince: number | null = null;
      const finishActiveInterval = (end: number) => {
        if (activeSince !== null && end > activeSince) activeIntervals.push([activeSince, end]);
        activeSince = null;
      };
      recordingClockRef.current = { startedAtMs: startedAt, pausedAccumMs: 0, pausedAtMs: 0 };
      const timeline = new SegmentTimeline();
      const transcriptWrites = new Set<Promise<void>>();
      let transcriptSaveFailed = false;
      const persistTranscript = (operation: Promise<void>) => {
        const write = operation.catch(() => {
          transcriptSaveFailed = true;
          onError('無法保存逐字稿或譯文，請檢查儲存空間。');
        });
        transcriptWrites.add(write);
        void write.then(() => transcriptWrites.delete(write));
        return write;
      };

      const pendingInterims = new Map<string, TranscriptSegment>();
      const finalizedIds = new Set<string>();
      let interimTimer: number | undefined;
      let interimChain = Promise.resolve();

      const flushPendingInterims = () => {
        window.clearTimeout(interimTimer);
        interimTimer = undefined;
        if (!pendingInterims.size) return;
        const batch = [...pendingInterims.values()].filter((item) => !finalizedIds.has(item.id));
        pendingInterims.clear();
        if (!batch.length) return;
        const write = (interimChain = interimChain
          .catch(() => {})
          .then(async () => {
            for (const draft of batch) {
              if (!finalizedIds.has(draft.id)) await saveInterimSegment(draft);
            }
          }));
        void persistTranscript(write);
      };
      flushInterimsRef.current = flushPendingInterims;

      const scheduleInterimSave = (draft: TranscriptSegment) => {
        if (finalizedIds.has(draft.id)) return;
        pendingInterims.set(draft.id, draft);
        if (interimTimer !== undefined) return;
        interimTimer = window.setTimeout(flushPendingInterims, INTERIM_SAVE_INTERVAL_MS);
      };

      const makeSegment = (
        anchor: { id: string; startedAtMs: number },
        track: AudioTrackRole,
        text: string,
        isFinal: boolean,
      ): TranscriptSegment => ({
        ...anchor,
        meetingId: saved.meetingId,
        recordingId: saved.id,
        track,
        speakerLabel: track === 'mic' ? '我方' : '對方',
        text,
        isFinal,
      });

      r.onstart = () => {
        startedAt = Date.now();
        activeSince = startedAt;
        recordingClockRef.current = { startedAtMs: startedAt, pausedAccumMs: 0, pausedAtMs: 0 };
      };
      r.onpause = () => {
        pausedAt = Date.now();
        finishActiveInterval(pausedAt);
        recordingClockRef.current.pausedAtMs = pausedAt;
      };
      r.onresume = () => {
        const now = Date.now();
        activeSince = Math.max(activeIntervals.at(-1)?.[1] ?? startedAt, now);
        if (pausedAt) pausedDuration += now - pausedAt;
        pausedAt = 0;
        if (recordingClockRef.current.pausedAtMs) {
          recordingClockRef.current.pausedAccumMs += now - recordingClockRef.current.pausedAtMs;
          recordingClockRef.current.pausedAtMs = 0;
        }
      };
      await saveRecording(saved);
      const usageSessionId = crypto.randomUUID();
      optionsRef.current.onActiveUsageSessionChange?.(usageSessionId);
      if (liveEnabled) {
        live = new LiveCapture();
        liveCapture.current = live;
        const provider = settings.liveProvider;
        const key = provider === 'openai' ? settings.openaiKey : settings.geminiKey;
        setLiveStatus('即時轉錄連線中…');
        await live
          .start(
            [
              { stream: mic, role: 'mic' },
              ...(display ? [{ stream: display, role: 'system' as const }] : []),
            ],
            {
              provider,
              model: provider === 'openai' ? settings.openaiLiveModel : settings.geminiLiveModel,
              apiKey: key || undefined,
              meetingId: meeting.id,
              meetingTitle: meeting.title,
              recordingId: saved.id,
              usageSessionId,
              languageHints: [
                languageCode(meeting.sourceLang || '繁體中文'),
                ...(meeting.mode === '雙語會議'
                  ? [languageCode(meeting.targetLang || 'English')]
                  : []),
              ].filter((value): value is string => Boolean(value)),
            },
            (event) => {
              if (event.type === 'session.ready') setLiveStatus('即時轉錄已連線');
              if (event.type === 'session.reconnecting') {
                setLiveStatus('即時轉錄重新連線中，音訊暫存在本機');
                const discarded = event.discardedInterims ?? [];
                if (event.track) timeline.retry(discarded, event.track);
                setInterims((old) => {
                  const next = { ...old };
                  for (const id of discarded) delete next[id];
                  return next;
                });
              }
              if (event.type === 'error') {
                setLiveStatus(event.message);
                if (
                  ['audio_unsent', 'audio_buffer_full', 'transcript_failed'].includes(event.code) ||
                  !event.recoverable
                )
                  onError(event.message);
              }
              if (event.type === 'transcript.interim') {
                const anchor = timeline.identify(
                  event.segmentId,
                  event.track,
                  Math.max(0, (pausedAt || Date.now()) - startedAt - pausedDuration),
                );
                if (event.text.trim()) {
                  scheduleInterimSave(makeSegment(anchor, event.track, event.text, false));
                }
                setInterims((old) => ({
                  ...old,
                  [event.segmentId]: { track: event.track, text: event.text },
                }));
              }
              if (event.type === 'transcript.final') {
                setInterims((old) => {
                  const next = { ...old };
                  delete next[event.segmentId];
                  return next;
                });
                const anchor = timeline.finish(
                  event.segmentId,
                  event.track,
                  Math.max(0, (pausedAt || Date.now()) - startedAt - pausedDuration - 700),
                );
                if (event.failed) {
                  flushPendingInterims();
                  return;
                }
                finalizedIds.add(anchor.id);
                pendingInterims.delete(anchor.id);
                if (!event.text.trim()) {
                  const clean = (interimChain = interimChain
                    .catch(() => {})
                    .then(async () => {
                      await deleteInterimSegment(anchor.id);
                    }));
                  void persistTranscript(clean);
                  return;
                }
                const segment = makeSegment(anchor, event.track, event.text, true);
                void persistTranscript(
                  saveSegment(segment).then(() => {
                    onAppendSegment(saved, segment);
                    onEnqueueTranslation([segment]);
                  }),
                );
              }
            },
            (role, level) => publishLevels({ ...levelsRef.current, [role]: level }),
            (role) => {
              const position = Math.max(0, Date.now() - startedAt - pausedDuration - 100);
              timeline.noteSpeech(role, position);
            },
          )
          .catch(() => {
            void live?.stop().catch(() => {});
            live = undefined;
            liveCapture.current = null;
            setLiveStatus('即時轉錄無法啟動，本機錄音仍會保存。');
          });
      }
      if (!live) startMeter(mic);
      recorder.current = r;
      let settleRecording: (saved: boolean) => void = () => {};
      recordingSettled.current = new Promise((resolve) => {
        settleRecording = resolve;
      });
      let sequence = 0;
      let writes = Promise.resolve();
      let failed = false;
      r.onerror = () => {
        failed = true;
        onError('錄音裝置發生錯誤，已保存的片段仍可恢復。');
      };
      r.ondataavailable = (e) => {
        if (!e.data.size) return;
        const index = sequence++;
        writes = writes
          .then(() => saveAudioChunk(saved.id, index, e.data))
          .catch(() => {
            failed = true;
            onError('錄音片段無法保存，請檢查儲存空間。已停止錄音。');
            if (r.state !== 'inactive') r.stop();
          });
      };
      r.onstop = () => {
        const stoppedAt = Math.max(startedAt, activeIntervals.at(-1)?.[1] ?? 0, Date.now());
        finishActiveInterval(stoppedAt);
        const elapsedSeconds =
          activeIntervals.reduce((ms, [start, end]) => ms + end - start, 0) / 1000;
        const isReload = reloadRequested.current;
        stopLocalMeter.current?.();
        stopLocalMeter.current = undefined;
        setRecording(false);
        setSavingRecording(true);
        setPaused(false);
        setBusy(true);
        let savedForReload = false;
        void (async () => {
          try {
            await live?.stop();
          } catch {
            onError('即時轉錄未能完整結束，仍會保存本機錄音與已收到的文字。');
          } finally {
            liveCapture.current = null;
            flushPendingInterims();
            flushInterimsRef.current = null;
            streams.current.forEach((item) => item.getTracks().forEach((track) => track.stop()));
            streams.current = [];
            if (mixer?.state !== 'closed') await mixer?.close().catch(() => {});
            mixContext.current = null;
          }
          await Promise.all([writes, ...transcriptWrites]);
          if (isReload) {
            await onFinishTranslationsForReload();
            await Promise.all(transcriptWrites);
          }
          optionsRef.current.onActiveUsageSessionChange?.(null);
          if (!failed)
            await saveRecording({
              ...saved,
              completed: true,
              durationSeconds: Math.floor(elapsedSeconds),
            });
          const [updatedRecordings, savedSegments] = await Promise.all([
            listRecordings(saved.meetingId),
            listSegments(saved.meetingId),
          ]);
          if (selectedRef.current === saved.meetingId) {
            onRecordingsUpdated(saved.meetingId, updatedRecordings);
            const drafts = savedSegments.filter(
              (item) => item.recordingId === saved.id && !item.isFinal,
            );
            onDraftsRecovered(saved, drafts);
          }
          const usageCompletion = optionsRef.current.onRecordingComplete?.({
            usageSessionId,
            meetingId: saved.meetingId,
            meetingTitle: meeting.title,
            startedAt,
            endedAt: stoppedAt,
            durationSeconds: elapsedSeconds,
            activeIntervals,
            isReload,
          });
          if (isReload) await usageCompletion;
          savedForReload = !failed && !transcriptSaveFailed;
          setLiveStatus('');
          setInterims({});
          publishLevels({ mic: 0, system: 0 });
        })()
          .catch(() => onError('無法完成錄音保存，已保存的片段仍可恢復。'))
          .finally(() => {
            recorder.current = null;
            settleRecording(savedForReload);
            setSavingRecording(false);
            setBusy(false);
          });
      };
      [...mic.getAudioTracks(), ...(display?.getAudioTracks() || [])].forEach((track) => {
        track.onended = () => {
          if (r.state !== 'inactive') r.stop();
        };
      });
      r.start(AUDIO_SLICE_MS);
      setRecording(true);
      setBusy(false);
    } catch (e) {
      optionsRef.current.onActiveUsageSessionChange?.(null);
      flushInterimsRef.current = null;
      mic?.getTracks().forEach((t) => t.stop());
      display?.getTracks().forEach((t) => t.stop());
      if (live) void live.stop().catch(() => {});
      liveCapture.current = null;
      stopLocalMeter.current?.();
      stopLocalMeter.current = undefined;
      if (mixer && mixer.state !== 'closed') void mixer.close().catch(() => {});
      mixContext.current = null;
      streams.current = [];
      publishLevels({ mic: 0, system: 0 });
      onError(
        e instanceof Error && e.message.startsWith('未選擇')
          ? e.message
          : '無法開始錄音或即時轉錄。請確認音訊權限及瀏覽器支援。',
      );
      setBusy(false);
    }
  }, [busy, publishLevels]);

  const stop = useCallback(() => {
    if (recorder.current?.state !== 'inactive') recorder.current?.stop();
  }, []);

  const saveRecordingAndReload = useCallback(async () => {
    const settlement = recordingSettled.current;
    if (!settlement || !recorder.current || recorder.current.state === 'inactive') return;
    reloadRequested.current = true;
    stop();
    const saved = await settlement;
    reloadRequested.current = false;
    if (!saved) return;
    const flushed = await optionsRef.current.onFlushAll();
    if (!flushed) return;
    allowSavedReload.current = true;
    window.location.reload();
  }, [stop]);

  const togglePause = useCallback(async () => {
    const r = recorder.current;
    if (!r || busy) return;
    setBusy(true);
    try {
      if (r.state === 'recording') {
        flushInterimsRef.current?.();
        checkpointAudio(r);
        r.pause();
        await liveCapture.current?.pause();
        publishLevels({ mic: 0, system: 0 });
        setPaused(true);
      } else if (r.state === 'paused') {
        await liveCapture.current?.resume();
        r.resume();
        setPaused(false);
      }
    } catch {
      optionsRef.current.onError('無法切換錄音狀態，請停止錄音後重試。');
    } finally {
      if (r.state !== 'inactive') setBusy(false);
    }
  }, [busy, publishLevels]);

  const resetStatus = useCallback(() => setLiveStatus(''), []);

  return {
    recording,
    savingRecording,
    busy,
    paused,
    elapsed,
    liveStatus,
    interims,
    subscribeLevels,
    start,
    stop,
    togglePause,
    saveRecordingAndReload,
    resetLiveStatus: resetStatus,
  };
}
