import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import type { ProviderId } from '../../shared/types';

export interface ProviderTextUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export async function* generateText(
  provider: ProviderId,
  key: string,
  model: string,
  instruction: string,
  input: string,
  signal?: AbortSignal,
  onUsage?: (usage: ProviderTextUsage) => void,
  onReference?: (id: string) => void,
): AsyncGenerator<string> {
  if (provider === 'openai') {
    const client = new OpenAI({ apiKey: key });
    const stream = await client.responses.create(
      {
        model,
        instructions: instruction,
        input,
        stream: true,
        store: false,
      },
      { signal },
    );
    let completed = false;
    for await (const event of stream) {
      if ('response' in event && event.response?.id) onReference?.(event.response.id);
      if (event.type === 'response.output_text.delta') yield event.delta;
      if (event.type === 'response.completed') completed = true;
      if (
        event.type === 'response.completed' ||
        event.type === 'response.incomplete' ||
        event.type === 'response.failed'
      ) {
        const usage = (
          event as {
            response?: {
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                total_tokens?: number;
                input_tokens_details?: { cached_tokens?: number };
              };
            };
          }
        ).response?.usage;
        if (usage) {
          const inputTokens = Number(usage.input_tokens) || 0;
          const outputTokens = Number(usage.output_tokens) || 0;
          onUsage?.({
            inputTokens,
            cachedInputTokens: Number(usage.input_tokens_details?.cached_tokens) || 0,
            outputTokens,
            totalTokens: Number(usage.total_tokens) || inputTokens + outputTokens,
          });
        }
      }
      if (
        event.type === 'response.incomplete' ||
        event.type === 'response.failed' ||
        event.type === 'error'
      )
        throw new Error('OpenAI response did not complete');
    }
    if (!completed) throw new Error('OpenAI response ended before completion');
  } else {
    const client = new GoogleGenAI({ apiKey: key });
    const stream = await client.models.generateContentStream({
      model,
      contents: input,
      config: { systemInstruction: instruction, abortSignal: signal },
    });
    let latestUsage:
      | {
          promptTokenCount?: number;
          cachedContentTokenCount?: number;
          candidatesTokenCount?: number;
          thoughtsTokenCount?: number;
          totalTokenCount?: number;
        }
      | undefined;
    for await (const chunk of stream) {
      if (chunk.responseId) onReference?.(chunk.responseId);
      if (chunk.usageMetadata) latestUsage = chunk.usageMetadata;
      if (chunk.text) yield chunk.text;
    }
    if (latestUsage) {
      const inputTokens = Number(latestUsage.promptTokenCount) || 0;
      const outputTokens =
        (Number(latestUsage.candidatesTokenCount) || 0) +
        (Number(latestUsage.thoughtsTokenCount) || 0);
      onUsage?.({
        inputTokens,
        cachedInputTokens: Number(latestUsage.cachedContentTokenCount) || 0,
        outputTokens,
        totalTokens: Number(latestUsage.totalTokenCount) || inputTokens + outputTokens,
      });
    }
  }
}
