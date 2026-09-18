import { createOpenAI } from '@ai-sdk/openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildAgent: vi.fn(),
  streamFn: vi.fn(() => vi.fn()),
}));
vi.mock('@/lib/agent/runtime/build-agent', () => ({ buildAgent: mocks.buildAgent }));
vi.mock('@/lib/agent/runtime/stream-fn', () => ({ createCallLlmStreamFn: mocks.streamFn }));
import { runSubagent } from '@/lib/livecourse/outline/subagent';

const runtime = {
  languageModel: createOpenAI({ apiKey: 'unused' }).chat('test-model'),
  thinkingConfig: { mode: 'enabled', effort: 'high' } as const,
  maxOutputTokens: 32768,
};
const task = {
  name: 'lesson-node:example',
  systemPrompt: 'Design teaching.',
  task: 'Explain the example.',
};

describe('lesson worker output completeness', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes the native model output window and reasoning through to the worker', async () => {
    mocks.buildAgent.mockReturnValue({
      prompt: vi.fn().mockResolvedValue(undefined),
      state: {
        messages: [
          {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'text', text: '{"design":"complete"}' }],
          },
        ],
      },
    });
    expect(await runSubagent(task, runtime)).toBe('{"design":"complete"}');
    expect(mocks.streamFn).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: 32768,
        thinkingConfig: runtime.thinkingConfig,
      }),
    );
  });

  it('recovers a complete JSON design dumped into the thinking channel', async () => {
    mocks.buildAgent.mockReturnValue({
      prompt: vi.fn().mockResolvedValue(undefined),
      state: {
        messages: [
          {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'thinking', thinking: '{"design":"complete"}' }],
          },
        ],
      },
    });
    expect(await runSubagent(task, runtime)).toBe('{"design":"complete"}');
  });

  it('does not invent JSON from truncated thinking', async () => {
    mocks.buildAgent.mockReturnValue({
      prompt: vi.fn().mockResolvedValue(undefined),
      state: {
        messages: [
          {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'thinking', thinking: '{"design":' }],
          },
        ],
      },
    });
    await expect(runSubagent(task, runtime)).rejects.toThrow('empty output');
  });

  it('rejects truncated JSON even when it would be syntactically parseable', async () => {
    mocks.buildAgent.mockReturnValue({
      prompt: vi.fn().mockResolvedValue(undefined),
      state: {
        messages: [
          {
            role: 'assistant',
            stopReason: 'length',
            content: [{ type: 'text', text: '{"design":"partial"}' }],
          },
        ],
      },
    });
    await expect(runSubagent(task, runtime)).rejects.toThrow('truncated');
  });

  it.each(['error', 'aborted'])('rejects a partial final answer after %s', async (stopReason) => {
    mocks.buildAgent.mockReturnValue({
      prompt: vi.fn().mockResolvedValue(undefined),
      state: {
        messages: [
          {
            role: 'assistant',
            stopReason,
            errorMessage: 'Upstream stream did not complete',
            content: [{ type: 'text', text: '{"design":"partial"}' }],
          },
        ],
      },
    });
    await expect(runSubagent(task, runtime)).rejects.toMatchObject({
      message: 'Upstream stream did not complete',
      name: stopReason === 'aborted' ? 'AbortError' : 'Error',
    });
  });
});
