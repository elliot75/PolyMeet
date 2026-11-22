import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamText } from '../src/client/services/apiClient';
import { defaults } from '../src/client/services/settings';

afterEach(() => vi.unstubAllGlobals());
function response(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200 },
  );
}
describe('streaming responses', () => {
  it('parses CRLF event boundaries split across network chunks', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response([
            'event: delta\r',
            '\ndata: {"text":"hello"}\r',
            '\n\r',
            '\nevent: done\r',
            '\ndata: {}\r',
            '\n\r',
            '\n',
          ]),
        ),
    );
    let output = '';
    await streamText(
      defaults,
      'minutes',
      {},
      (text) => {
        output += text;
      },
      new AbortController().signal,
    );
    expect(output).toBe('hello');
  });
  it('rejects streams that end without a completion event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response(['event: delta\ndata: {"text":"partial"}\n\n'])),
    );
    await expect(
      streamText(defaults, 'minutes', {}, () => {}, new AbortController().signal),
    ).rejects.toThrow('連線中斷');
  });
});
