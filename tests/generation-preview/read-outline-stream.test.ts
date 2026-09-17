import { expect, it, vi } from 'vitest';
import { readOutlineStream } from '@/app/generation-preview/read-outline-stream';

const outline = {
  id: 'outline-1',
  type: 'interactive',
  title: '中文课堂',
  description: 'A concept',
  keyPoints: ['Concept'],
  order: 1,
};
const messages = { failed: 'outline-failed', empty: 'outline-empty', unreadable: 'unreadable' };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function read(response: Response, controller = new AbortController()) {
  return readOutlineStream(response, {
    signal: controller.signal,
    onOutlines: vi.fn(),
    onRetry: vi.fn(),
    messages,
  });
}

it('handles UTF-8 characters and JSON split at every byte without dropping the final event', async () => {
  const bytes = new TextEncoder().encode(
    ':heartbeat\r\n\r\n' +
      event({ type: 'outline', data: outline }) +
      `data:${JSON.stringify({ type: 'done', outlines: [outline], courseTitle: '中文课程' })}`,
  );
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
  );
  await expect(read(response)).resolves.toMatchObject({
    outlines: [outline],
    courseTitle: '中文课程',
  });
});

it('accepts multiline data fields with CRLF framing', async () => {
  const response = new Response(
    `data: {"type":"done",\r\ndata: "outlines":${JSON.stringify([outline])}}\r\n\r\n`,
  );
  await expect(read(response)).resolves.toMatchObject({ outlines: [outline] });
});

it('uses the terminal reviewed outlines rather than the incremental draft', async () => {
  const final = { ...outline, id: 'reviewed' };
  await expect(
    read(
      new Response(
        event({ type: 'outline', data: outline }) + event({ type: 'done', outlines: [final] }),
      ),
    ),
  ).resolves.toMatchObject({ outlines: [final] });
});

it('drops all metadata and draft outlines when the server announces a retry', async () => {
  const onOutlines = vi.fn();
  const onRetry = vi.fn();
  const response = new Response(
    event({ type: 'languageDirective', data: 'Stale language' }) +
      event({ type: 'courseTitle', data: 'Stale title' }) +
      event({ type: 'outline', data: outline }) +
      event({ type: 'retry' }) +
      event({ type: 'done', outlines: [outline], effectiveTaskEngineMode: true }),
  );
  const result = await readOutlineStream(response, {
    signal: new AbortController().signal,
    onOutlines,
    onRetry,
    messages,
  });
  expect(onOutlines.mock.calls).toEqual([[[outline]], [[]]]);
  expect(onRetry).toHaveBeenCalledOnce();
  expect(result.courseTitle).toBeUndefined();
  expect(result.languageDirective).not.toBe('Stale language');
  expect(result.taskEngineMode).toBe(true);
});

it.each([
  event({ type: 'outline', data: outline }),
  event({ type: 'done', outlines: [outline, outline] }),
  event({ type: 'done', outlines: [{ ...outline, order: '1' }] }),
  event({ type: 'outline', data: null }),
  'data: {broken}\n\n',
])('rejects incomplete or invalid stream data: %s', async (body) => {
  await expect(read(new Response(body))).rejects.toBeInstanceOf(Error);
});

it('preserves an upstream error and cancels a still-open response', async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(event({ type: 'error', error: 'Rate limited' })),
        );
      },
      cancel,
    }),
  );
  await expect(read(response)).rejects.toThrow('Rate limited');
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body?.locked).toBe(false);
});

it('aborts a blocked reader and releases its stream lock', async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }));
  const controller = new AbortController();
  const result = read(response, controller);
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancel).toHaveBeenCalledOnce();
  expect(response.body?.locked).toBe(false);
});

it('reports a non-JSON gateway failure with its HTTP status', async () => {
  await expect(read(new Response('<html>Bad Gateway</html>', { status: 502 }))).rejects.toThrow(
    'HTTP 502',
  );
});
