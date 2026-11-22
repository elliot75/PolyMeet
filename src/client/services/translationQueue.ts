import type { TranscriptSegment } from '../../shared/types';
import { streamText } from './apiClient';
import type { Settings } from './settings';

export function needsTranslation(segment: TranscriptSegment) {
  return (
    segment.isFinal &&
    !!segment.text.trim() &&
    (!segment.translation?.trim() || segment.translationIsFinal === false)
  );
}

export class TranslationQueue {
  private queue: Promise<void> = Promise.resolve();
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
    private onError: () => void,
  ) {}

  add(segment: TranscriptSegment): Promise<void> | undefined {
    if (this.aborted || this.jobs.has(segment.id)) return;
    const controller = new AbortController();
    this.jobs.set(segment.id, controller);
    return (this.queue = this.queue.then(async () => {
      if (controller.signal.aborted) return;
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
      try {
        await streamText(
          options,
          'translate',
          {
            text: `Context:\n${context}\n\nCurrent speech:\n${segment.text}`,
            sourceLanguage: this.sourceLanguage,
            targetLanguage: this.targetLanguage,
          },
          (chunk) => {
            if (controller.signal.aborted) return;
            translated += chunk;
            void this.onUpdate(segment, translated, false, controller.signal);
          },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          if (!translated.trim()) throw new Error('Empty translation');
          await this.onUpdate(segment, translated, true, controller.signal);
        }
      } catch {
        if (!controller.signal.aborted) this.onError();
      } finally {
        if (this.jobs.get(segment.id) === controller) this.jobs.delete(segment.id);
      }
    }));
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
        this.queue,
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
