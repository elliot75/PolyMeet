import { headers, model, type Settings } from './settings';
export async function streamText(
  settings: Settings,
  operation: 'minutes' | 'translate',
  params: Record<string, string>,
  onText: (text: string) => void,
  signal: AbortSignal,
) {
  const response = await fetch(`/api/${operation}/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers(settings) },
    body: JSON.stringify({ provider: settings.provider, model: model(settings), ...params }),
    signal,
  });
  if (!response.ok || !response.body) {
    const result = await response.json().catch(() => ({}));
    throw new Error(
      result.error === 'missing_api_key'
        ? '請先設定 API 金鑰，或在伺服器設定金鑰。'
        : '無法連線至服務，請確認後端已啟動。',
    );
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '',
    doneEvent = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += chunk.value;
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r(?!$)/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = frame
          .split('\n')
          .find((line) => line.startsWith('event:'))
          ?.slice(6)
          .trim();
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (event === 'error') throw new Error('AI 服務無法完成請求，請檢查金鑰及模型設定。');
        if (event === 'done') doneEvent = true;
        if (event === 'delta') onText(JSON.parse(data).text);
      }
    }
    if (!doneEvent) throw new Error('連線中斷，請重試。');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
