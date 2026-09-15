import { describe, expect, it } from 'vitest';
import { parseClassroomHtml } from '@/lib/livecourse/lesson/html-presentation';
import { callLLM, completeLLMText } from '@/lib/ai/llm';
import { getModel } from '@/lib/ai/providers';

const html =
  '<!DOCTYPE html><html><head><title>t</title></head><body><p id="why">ok</p></body></html>';

function sseResponse(chunks: unknown[]): Response {
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
}

function reasoningOnlyStream(page: string, sameChunkFinish: boolean): Response {
  const model = 'DeepSeek-V4.1-Flash';
  const chunks: unknown[] = [
    {
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    },
  ];
  if (sameChunkFinish) {
    chunks.push({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: { reasoning_content: page }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 8, total_tokens: 9 },
    });
  } else {
    chunks.push({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: { reasoning_content: page }, finish_reason: null }],
    });
    chunks.push({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 8, total_tokens: 9 },
    });
  }
  return sseResponse(chunks);
}

function reasoningOnlyJson(page: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'DeepSeek-V4.1-Flash',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: page,
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 8, total_tokens: 9 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

async function withAipingFlash<T>(
  respond: (init?: RequestInit) => Response,
  run: (model: ReturnType<typeof getModel>['model']) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    respond(init)) as typeof globalThis.fetch;
  try {
    const { model } = getModel({
      providerId: 'aiping',
      modelId: 'DeepSeek-V4.1-Flash',
      apiKey: 'sk-test',
    });
    return await run(model);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('DeepSeek-V4.1-Flash HTML dumped into reasoning_content', () => {
  it('recovers a complete page from a streamed reasoning-only completion', async () => {
    const text = await withAipingFlash(
      () => reasoningOnlyStream(html, false),
      (model) => completeLLMText({ model, prompt: 'page' }, 'scene-content'),
    );
    expect(parseClassroomHtml(text)).toContain('<p id="why">ok</p>');
  });

  it('recovers a complete page when finish_reason arrives on the last reasoning chunk', async () => {
    const text = await withAipingFlash(
      () => reasoningOnlyStream(html, true),
      (model) => completeLLMText({ model, prompt: 'page' }, 'scene-content'),
    );
    expect(parseClassroomHtml(text)).toContain('<p id="why">ok</p>');
  });

  it('recovers a complete page from a non-streaming reasoning-only completion', async () => {
    const result = await withAipingFlash(
      () => reasoningOnlyJson(html),
      (model) => callLLM({ model, prompt: 'page' }, 'generate-classroom-scene'),
    );
    expect(parseClassroomHtml(result.text || result.reasoningText || '')).toContain(
      '<p id="why">ok</p>',
    );
  });
});
