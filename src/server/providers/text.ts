import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import type { ProviderId } from '../../shared/types';

export async function* generateText(
  provider: ProviderId,
  key: string,
  model: string,
  instruction: string,
  input: string,
  signal?: AbortSignal,
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
      if (event.type === 'response.output_text.delta') yield event.delta;
      if (event.type === 'response.completed') completed = true;
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
    for await (const chunk of stream) if (chunk.text) yield chunk.text;
  }
}
