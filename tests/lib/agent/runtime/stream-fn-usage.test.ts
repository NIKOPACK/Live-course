import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn() }));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));

import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';

describe('createCallLlmStreamFn usage', () => {
  beforeEach(() => mocks.streamLLM.mockReset());

  it('writes AI SDK token usage into the completed Pi assistant message', async () => {
    mocks.streamLLM.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'answer' };
      })(),
      usage: Promise.resolve({
        inputTokens: 120,
        outputTokens: 30,
        inputTokenDetails: { cacheReadTokens: 10, cacheWriteTokens: 5 },
      }),
    });
    const streamFn = createCallLlmStreamFn({ languageModel: {} as never });

    const stream = await streamFn(
      {} as never,
      { systemPrompt: 'test', messages: [], tools: [] },
      {},
    );
    const message = await stream.result();

    expect(message.usage).toMatchObject({
      input: 105,
      output: 30,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 150,
    });
  });

  it.each(['stop', 'length'] as const)(
    'preserves the actual %s finish reason instead of marking a truncated output complete',
    async (finishReason) => {
      mocks.streamLLM.mockReturnValue({
        fullStream: (async function* () {
          yield { type: 'text-delta', text: '{"design":"answer"}' };
        })(),
        usage: Promise.resolve({ inputTokens: 10, outputTokens: 20 }),
        finishReason: Promise.resolve(finishReason),
      });
      const streamFn = createCallLlmStreamFn({
        languageModel: {} as never,
        maxOutputTokens: 32768,
      });
      const stream = await streamFn(
        {} as never,
        { systemPrompt: 'test', messages: [], tools: [] },
        {},
      );
      const events = [];
      for await (const event of stream) events.push(event);

      expect((await stream.result()).stopReason).toBe(finishReason);
      expect(events.at(-1)).toMatchObject({ type: 'done', reason: finishReason });
      expect(mocks.streamLLM).toHaveBeenCalledWith(
        expect.objectContaining({ maxOutputTokens: 32768 }),
        'livecourse-agent',
        undefined,
      );
    },
  );
});
