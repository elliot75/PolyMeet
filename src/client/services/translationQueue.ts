import type { TranscriptSegment } from '../../shared/types';
import { streamText } from './apiClient';
import type { Settings } from './settings';

export class TranslationQueue {
  private queue: Promise<void> = Promise.resolve();
  private context: string[] = [];
  constructor(
    private settings: Settings,
    private sourceLanguage: string,
    private targetLanguage: string,
    private onUpdate: (segment: TranscriptSegment, text: string, final: boolean) => void,
    private onError: () => void,
  ) {}
  add(segment: TranscriptSegment) {
    const context = this.context.slice(-4).join('\n');
    this.context.push(segment.text);
    this.queue = this.queue
      .then(async () => {
        let translated = '';
        const options = {
          ...this.settings,
          provider: this.settings.translationProvider,
          openaiModel: this.settings.openaiTranslationModel,
          geminiModel: this.settings.geminiTranslationModel,
        };
        await streamText(
          options,
          'translate',
          {
            text: `Context:\n${context}\n\nCurrent speech:\n${segment.text}`,
            sourceLanguage: this.sourceLanguage,
            targetLanguage: this.targetLanguage,
          },
          (chunk) => {
            translated += chunk;
            this.onUpdate(segment, translated, false);
          },
          new AbortController().signal,
        );
        this.onUpdate(segment, translated, true);
      })
      .catch(() => this.onError());
  }
}
