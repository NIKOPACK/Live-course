import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/generate/scene-outlines-stream/route';
import { readOutlineStream } from '@/app/generation-preview/read-outline-stream';

const mocks = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.stream }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: async () => ({
    model: {},
    modelInfo: { outputWindow: 4096, capabilities: {} },
  }),
}));

const outline = {
  id: 'partial',
  type: 'slide',
  title: 'Partial concept',
  description: 'A streamed concept',
  keyPoints: ['Concept'],
  order: 1,
};
const prefix = `{"outlines":[${JSON.stringify(outline)}`;
const request = () =>
  new NextRequest('http://localhost/api/generate/scene-outlines-stream', {
    method: 'POST',
    body: JSON.stringify({ requirements: { requirement: 'Explain a concept' } }),
  });
beforeEach(() => mocks.stream.mockReset());

it.each(['upstream-error', 'truncated-array', 'buffer-limit'] as const)(
  'does not publish partial outlines as done after %s exhausts retries',
  async (failure) => {
    mocks.stream.mockImplementation(() => ({
      textStream: (async function* () {
        yield prefix;
        if (failure === 'upstream-error') throw new Error('Connection reset');
        if (failure === 'buffer-limit') yield ' '.repeat(512 * 1024);
      })(),
    }));
    const response = await POST(request());
    const events = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    expect(events.filter((event) => event.type === 'done')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'retry')).toHaveLength(2);
    expect(events.at(-1).type).toBe('error');
    expect(mocks.stream).toHaveBeenCalledTimes(3);
  },
);

it('recovers a failed partial attempt with only the successful final outline set', async () => {
  mocks.stream
    .mockImplementationOnce(() => ({
      textStream: (async function* () {
        yield `{"courseTitle":"Discarded","outlines":[${JSON.stringify(outline)}`;
        throw new Error('Connection reset');
      })(),
    }))
    .mockImplementation(() => ({
      textStream: (async function* () {
        yield JSON.stringify({
          courseTitle: 'Complete course',
          outlines: [{ ...outline, id: 'complete', title: 'Complete concept' }],
        });
      })(),
    }));
  const onOutlines = vi.fn();
  const onRetry = vi.fn();
  const result = await readOutlineStream(await POST(request()), {
    signal: new AbortController().signal,
    onOutlines,
    onRetry,
    messages: { failed: 'failed', empty: 'empty', unreadable: 'unreadable' },
  });
  expect(result.outlines.map((outline) => outline.id)).toEqual(['complete']);
  expect(result.courseTitle).toBe('Complete course');
  expect(onRetry).toHaveBeenCalledOnce();
  expect(onOutlines).toHaveBeenCalledWith([]);
});

it('accepts a complete fenced array split across chunks with nested arrays and quoted brackets', async () => {
  mocks.stream.mockImplementation(() => ({
    textStream: (async function* () {
      yield `\`\`\`json\n[${JSON.stringify({ ...outline, description: 'A ] bracket' })}`;
      yield ']\n```';
    })(),
  }));
  const response = await POST(request());
  const text = await response.text();
  expect(text).toContain('"type":"done"');
  expect(mocks.stream).toHaveBeenCalledOnce();
});
