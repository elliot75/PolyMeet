import type { TranscriptSegment } from '../../shared/types';
import { streamText } from './apiClient';
import type { Settings } from './settings';

export class TranslationQueue {
  private queue: Promise<void> = Promise.resolve();
  private context: string[] = [];
  private aborted = false;
  private currentController?: AbortController;

  constructor(
    private settings: Settings,
    private sourceLanguage: string,
    private targetLanguage: string,
    private onUpdate: (segment: TranscriptSegment, text: string, final: boolean) => void,
    private onError: () => void,
  ) {}

  add(segment: TranscriptSegment) {
    if (this.aborted) return;
    const context = this.context.slice(-4).join('\n');
    this.context.push(segment.text);
    if (this.context.length > 4) this.context.shift();
    this.queue = this.queue.then(async () => {
      if (this.aborted) return;
      const controller = new AbortController();
      this.currentController = controller;
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
            if (this.aborted || controller.signal.aborted) return;
            translated += chunk;
            this.onUpdate(segment, translated, false);
          },
          controller.signal,
        );
        if (!this.aborted && !controller.signal.aborted) {
          this.onUpdate(segment, translated, true);
        }
      } catch {
        if (!this.aborted && !controller.signal.aborted) {
          this.onError();
        }
      } finally {
        if (this.currentController === controller) {
          this.currentController = undefined;
        }
      }
    });
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
    this.currentController?.abort();
  }
}
