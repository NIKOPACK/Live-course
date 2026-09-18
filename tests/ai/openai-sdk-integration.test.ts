import { createOpenAI } from '@ai-sdk/openai';
import { generateText, stepCountIs, streamText, tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { resolveThinkingProviderOptions } from '@/lib/ai/llm';
import { getModel } from '@/lib/ai/providers';
import { normalizeResponsesMetadata } from '@/lib/ai/openai-responses-compat';

describe('OpenAI SDK integration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts missing annotations from a custom Responses proxy without changing text or usage', async () => {
    const response = {
      id: 'resp_proxy',
      object: 'response',
      created_at: 1,
      model: 'gpt-5.5',
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'msg_proxy',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: '{"checks":["verified"],"issues":[]}' }],
        },
      ],
      usage: { input_tokens: 62, output_tokens: 269, total_tokens: 331 },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify(response), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const { model } = getModel({
      providerId: 'openai',
      modelId: 'gpt-5.5',
      apiKey: 'test',
      baseUrl: 'https://proxy.example/v1',
    });
    const result = await generateText({ model, prompt: 'Review', maxRetries: 0 });
    expect(result.text).toBe(response.output[0].content[0].text);
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toMatchObject({ inputTokens: 62, outputTokens: 269, totalTokens: 331 });
  });

  it.each([
    {
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'x', annotations: null }] },
      ],
    },
    { error: { message: 'upstream error' } },
  ])('does not hide invalid fields or upstream errors (%j)', async (body) => {
    const response = new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    });
    expect(await normalizeResponsesMetadata(response)).toBe(response);
  });

  it('preserves incomplete status, known annotations, usage and response headers', async () => {
    const annotated = {
      type: 'output_text',
      text: 'Known citation',
      annotations: [{ type: 'url_citation', url: 'https://example.com' }],
    };
    const body = {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', content: [annotated, { type: 'output_text', text: 'partial' }] }],
      usage: { output_tokens: 32768 },
    };
    const response = await normalizeResponsesMetadata(
      new Response(JSON.stringify(body), {
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req_test',
          'content-length': '1',
        },
      }),
    );
    expect(await response.json()).toEqual({
      ...body,
      output: [
        {
          type: 'message',
          content: [annotated, { type: 'output_text', text: 'partial', annotations: [] }],
        },
      ],
    });
    expect(response.headers.get('x-request-id')).toBe('req_test');
    expect(response.headers.has('content-length')).toBe(false);
  });

  it('leaves invalid JSON, HTTP errors and SSE available to the original SDK handler', async () => {
    for (const response of [
      new Response('{', { headers: { 'content-type': 'application/json' } }),
      new Response('{"error":"failed"}', {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
      new Response('data: {"type":"response.created"}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    ]) {
      const original = await response.clone().text();
      expect(await normalizeResponsesMetadata(response)).toBe(response);
      expect(await response.text()).toBe(original);
    }
  });
  it('accepts GPT-5.6 max reasoning effort and sends it to the Responses API', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

      return new Response(
        JSON.stringify({
          id: 'resp_test',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: 'gpt-5.6',
          output: [
            {
              id: 'msg_test',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok', annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const openai = createOpenAI({ apiKey: 'sk-test', fetch: fetchMock });

    const result = await generateText({
      model: openai.responses('gpt-5.6'),
      prompt: 'hi',
      providerOptions: { openai: { reasoningEffort: 'max' } },
    });

    expect(result.text).toBe('ok');
    expect(requestBody).toMatchObject({
      model: 'gpt-5.6',
      reasoning: { effort: 'max' },
    });
  });

  it('preserves compatible provider identity for direct thinking option resolution', () => {
    const { model } = getModel({
      providerId: 'kimi',
      modelId: 'kimi-k3',
      apiKey: 'sk-test',
    });

    expect((model as { provider: string }).provider).toBe('kimi.chat');
    expect(
      resolveThinkingProviderOptions(model, {
        mode: 'enabled',
        effort: 'high',
      }),
    ).toEqual({
      openai: {
        reasoningEffort: 'high',
      },
    });
  });

  it('preserves Kimi K3 reasoning_content across automatic tool continuations', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const firstStep = requestBodies.length === 1;
      const chunks = firstStep
        ? [
            {
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'kimi-k3',
              choices: [
                {
                  index: 0,
                  delta: { reasoning_content: 'use the lookup tool' },
                  finish_reason: null,
                },
              ],
            },
            {
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'kimi-k3',
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'lookup', arguments: '{}' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'kimi-k3',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          ]
        : [
            {
              id: 'chatcmpl-2',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'kimi-k3',
              choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }],
            },
            {
              id: 'chatcmpl-2',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'kimi-k3',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          ];
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof globalThis.fetch;

    try {
      const { model } = getModel({
        providerId: 'kimi',
        modelId: 'kimi-k3',
        apiKey: 'sk-test',
      });
      const result = streamText({
        model,
        prompt: 'find it',
        tools: {
          lookup: tool({
            description: 'lookup',
            inputSchema: z.object({}),
            execute: async () => ({ found: true }),
          }),
        },
        stopWhen: stepCountIs(2),
      });

      await result.consumeStream();

      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[1]).toMatchObject({
        messages: [
          { role: 'user', content: 'find it' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: 'use the lookup tool',
            tool_calls: [{ id: 'call-1' }],
          },
          { role: 'tool', tool_call_id: 'call-1' },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
