import type { TranscriptSegment, UsageMetric } from '../../shared/types';
import { gpt6LunaModel } from '../../shared/models';
import { streamText } from './apiClient';
import type { Settings } from './settings';

export function needsTranslation(segment: TranscriptSegment) {
  return (
    segment.isFinal &&
    !!segment.text.trim() &&
    (!segment.translation?.trim() || segment.translationIsFinal === false)
  );
}

export interface TranslationUsageContext {
  meetingId: string;
  meetingTitle: string;
  usageSessionId?: string;
  live?: boolean;
}

const MAX_ACTIVE_TRANSLATIONS = 2;
const LIVE_FIRST_TEXT_TIMEOUT_MS = 8_000;

export class TranslationQueue {
  // Dispatch in transcript order without waiting for each translation to finish.
  private dispatchQueue: Promise<void> = Promise.resolve();
  private active = new Set<Promise<void>>();
  private context: Pick<TranscriptSegment, 'id' | 'text'>[] = [];
  private aborted = false;
  private jobs = new Map<string, AbortController>();

  constructor(
    private settings: Settings,
    private sourceLanguage: string,
    private targetLanguage: string,
    private onUpdate: (
      segment: TranscriptSegment,
      text: string,
      final: boolean,
      signal: AbortSignal,
    ) => void | Promise<void>,
    private onError: (reason?: 'first-text-timeout') => void,
  ) {}

  add(
    segment: TranscriptSegment,
    usageContext?: TranslationUsageContext,
    onUsage?: (usage: UsageMetric) => void,
  ): Promise<void> | undefined {
    if (this.aborted || this.jobs.has(segment.id)) return;
    const controller = new AbortController();
    this.jobs.set(segment.id, controller);
    const dispatched = this.dispatchQueue.then(async () => {
      if (controller.signal.aborted) return;
      if (this.active.size >= MAX_ACTIVE_TRANSLATIONS) {
        await Promise.race(this.active).catch(() => {});
      }
      if (controller.signal.aborted) return;
      const job = this.translate(segment, controller, usageContext, onUsage).finally(() => {
        this.active.delete(job);
        if (this.jobs.get(segment.id) === controller) this.jobs.delete(segment.id);
      });
      this.active.add(job);
      return { job };
    });
    this.dispatchQueue = dispatched.then(() => {});
    return dispatched.then((result) => result?.job);
  }

  private async translate(
    segment: TranscriptSegment,
    controller: AbortController,
    usageContext?: TranslationUsageContext,
    onUsage?: (usage: UsageMetric) => void,
  ): Promise<void> {
    const { signal } = controller;
    const prior = this.context.filter((item) => item.id !== segment.id);
    const context = prior.map((item) => item.text).join('\n');
    this.context = [...prior, { id: segment.id, text: segment.text }].slice(-4);
    let translated = '';
    const options = {
      ...this.settings,
      provider: this.settings.translationProvider,
      openaiModel: this.settings.openaiTranslationModel,
      geminiModel: this.settings.geminiTranslationModel,
    };
    const reasoningEffort =
      options.provider === 'openai' && options.openaiModel === gpt6LunaModel
        ? this.settings.openaiTranslationReasoningEffort
        : '';
    let firstTextTimer = usageContext?.live
      ? setTimeout(() => {
          controller.abort(
            new DOMException('Live translation did not start in time', 'TimeoutError'),
          );
        }, LIVE_FIRST_TEXT_TIMEOUT_MS)
      : undefined;
    try {
      const corrected = await streamText(
        options,
        'translate',
        {
          text: `Context:\n${context}\n\nCurrent speech:\n${segment.text}`,
          sourceLanguage: this.sourceLanguage,
          targetLanguage: this.targetLanguage,
          streamDraft: '1',
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(usageContext?.meetingId ? { meetingId: usageContext.meetingId } : {}),
          ...(usageContext?.meetingTitle ? { meetingTitle: usageContext.meetingTitle } : {}),
          ...(usageContext?.usageSessionId ? { usageSessionId: usageContext.usageSessionId } : {}),
        },
        (chunk) => {
          if (signal.aborted) return;
          if (firstTextTimer !== undefined && chunk.trim()) {
            clearTimeout(firstTextTimer);
            firstTextTimer = undefined;
          }
          translated += chunk;
          void this.onUpdate(segment, translated, false, signal);
        },
        signal,
        onUsage,
      );
      if (signal.aborted) return;
      const finalText = corrected ?? translated;
      if (!finalText.trim()) throw new Error('Empty translation');
      await this.onUpdate(segment, finalText, true, signal);
    } catch {
      if (signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError') {
        this.onError('first-text-timeout');
      } else if (!signal.aborted) {
        this.onError();
      }
    } finally {
      clearTimeout(firstTextTimer);
    }
  }

  remove(id: string) {
    this.jobs.get(id)?.abort();
    this.jobs.delete(id);
    this.context = this.context.filter((item) => item.id !== id);
  }

  async finish(timeoutMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.dispatchQueue.then(() => Promise.all(this.active)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.cancel();
    }
  }

  cancel() {
    this.aborted = true;
    for (const controller of this.jobs.values()) controller.abort();
    this.jobs.clear();
  }
}
