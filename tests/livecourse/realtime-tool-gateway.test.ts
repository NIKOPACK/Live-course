import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/livecourse/realtime/tools/route';
import { createRealtimeToolsRouteHandler } from '@/app/api/livecourse/realtime/tools/handler';
import { AssistantTaskService } from '@/lib/livecourse/domain';
import { realtimeToolRequestSchema } from '@/lib/livecourse/realtime/contracts';
import { mapRealtimeToolRequest } from '@/lib/livecourse/realtime/server/tool-gateway';
import { AssistantTaskGateway } from '@/lib/livecourse/realtime/server/assistant-task-gateway';

const BASE_REQUEST = {
  courseId: 'course-1',
  lessonId: 'lesson-1',
  nodeId: 'node-1',
  sceneId: 'scene-1',
  callId: 'call-123',
} as const;

function requestTool(body: unknown, learnerKey = 'learner-42'): Promise<Response> {
  return POST(
    new Request('http://localhost/api/livecourse/realtime/tools', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(learnerKey ? { 'x-learner-key': learnerKey } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Realtime tool gateway', () => {
  it('rejects a call id that cannot produce a valid idempotency key', () => {
    const result = realtimeToolRequestSchema.safeParse({
      ...BASE_REQUEST,
      callId: 'x'.repeat(232),
      tool: { name: 'board_clear', arguments: {} },
    });

    expect(result.success).toBe(false);
  });

  it('maps board text to a deterministic, escaped and idempotent classroom command', () => {
    const request = {
      ...BASE_REQUEST,
      tool: {
        name: 'board_text' as const,
        arguments: {
          content: '  <b>A & "B" \'C\'</b>  ',
          x: 24,
          y: 48,
          color: '#123456',
        },
      },
    };

    const first = mapRealtimeToolRequest(request);
    const replay = mapRealtimeToolRequest(request);

    expect(first).toEqual(replay);
    expect(first).toEqual({
      success: true,
      command: {
        nodeId: 'node-1',
        idempotencyKey: 'realtime:call-123',
        type: 'board.apply',
        payload: {
          operation: 'add',
          elementId: 'realtime-text-6c25371237b71c93cf9d',
          element: {
            id: 'realtime-text-6c25371237b71c93cf9d',
            type: 'text',
            left: 24,
            top: 48,
            width: 420,
            height: 100,
            rotate: 0,
            content: '<p>&lt;b&gt;A &amp; &quot;B&quot; &#39;C&#39;&lt;/b&gt;</p>',
            defaultFontName: 'Inter',
            defaultColor: '#123456',
            lineHeight: 1.4,
          },
        },
      },
      message: 'Classroom action board.apply accepted by the tool gateway.',
    });
  });

  it.each([
    [
      'goto_node',
      { name: 'goto_node', arguments: { targetNodeId: 'node-2' } },
      'lesson.goto_node',
      { targetNodeId: 'node-2' },
    ],
    [
      'highlight',
      {
        name: 'highlight',
        arguments: {
          elementId: 'element-1',
          durationMs: 2_000,
          color: '#ffee00',
          style: 'outline',
        },
      },
      'stage.highlight',
      {
        sceneId: 'scene-1',
        elementId: 'element-1',
        durationMs: 2_000,
        color: '#ffee00',
        style: 'outline',
      },
    ],
    [
      'pointer',
      { name: 'pointer', arguments: { elementId: 'element-1', x: 0, y: 1 } },
      'stage.pointer',
      { sceneId: 'scene-1', elementId: 'element-1', x: 0, y: 1 },
    ],
    ['board_clear', { name: 'board_clear', arguments: {} }, 'board.clear', {}],
    [
      'set_expression',
      { name: 'set_expression', arguments: { expression: 'happy', intensity: 0.75 } },
      'avatar.expression',
      { expression: 'happy', intensity: 0.75 },
    ],
    [
      'look_at',
      { name: 'look_at', arguments: { target: 'whiteboard' } },
      'avatar.look_at',
      { target: 'whiteboard' },
    ],
    [
      'show_source',
      { name: 'show_source', arguments: { sourceId: 'source-1', page: 3 } },
      'source.show',
      { sourceId: 'source-1', page: 3 },
    ],
  ])('maps the allowlisted %s tool', (_name, tool, type, payload) => {
    const result = mapRealtimeToolRequest({
      ...BASE_REQUEST,
      tool,
    });

    expect(result).toHaveProperty('command');
    if (!('command' in result)) throw new Error('expected a teaching command response');
    expect(result.command).toMatchObject({
      nodeId: 'node-1',
      idempotencyKey: 'realtime:call-123',
      type,
      payload,
    });
  });
});

describe('POST /api/livecourse/realtime/tools', () => {
  it('returns a no-store command for a strictly valid request', async () => {
    const response = await requestTool({
      ...BASE_REQUEST,
      tool: { name: 'goto_node', arguments: { targetNodeId: 'node-2' } },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      command: {
        type: 'lesson.goto_node',
        payload: { targetNodeId: 'node-2' },
      },
    });
  });

  it('uses the configured gateway through the actual HTTP handler path', async () => {
    const service = new AssistantTaskService({ now: () => '2026-08-17T01:00:00.000Z' });
    const gateway = new AssistantTaskGateway({
      taskService: service,
      getActiveClassroom: () => ({
        courseId: 'course-1',
        lessonId: 'lesson-1',
        nodeId: 'node-1',
        sceneId: 'scene-1',
        active: true,
        teacherId: 'teacher-1',
      }),
      roster: {
        getAssistant: (id) => (id === 'assistant-1' ? { id, kinds: ['draft_board_note'] } : null),
      },
    });
    const handler = createRealtimeToolsRouteHandler({
      assistantTaskGateway: gateway,
      identity: { learnerId: 'learner-1', teacherId: 'teacher-1' },
    });

    const response = await handler(
      new Request('http://localhost/api/livecourse/realtime/tools', {
        method: 'POST',
        body: JSON.stringify({
          ...BASE_REQUEST,
          tool: {
            name: 'delegate_assistant_task',
            arguments: {
              assistantId: 'assistant-1',
              kind: 'draft_board_note',
              inputRefs: ['source-1'],
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ success: true, task: { status: 'queued' } });
    expect(payload).not.toHaveProperty('command');
    expect(service.list()).toHaveLength(1);
  });

  it('requires learner identity before accepting a tool call', async () => {
    const response = await requestTool(
      {
        ...BASE_REQUEST,
        tool: { name: 'board_clear', arguments: {} },
      },
      '',
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'LEARNER_ID_REQUIRED' },
    });
  });

  it.each([
    [
      'unknown tool',
      { ...BASE_REQUEST, tool: { name: 'run_script', arguments: { code: 'alert(1)' } } },
    ],
    [
      'unknown top-level field',
      {
        ...BASE_REQUEST,
        sequence: 7,
        tool: { name: 'board_clear', arguments: {} },
      },
    ],
    [
      'unknown argument',
      {
        ...BASE_REQUEST,
        tool: { name: 'goto_node', arguments: { targetNodeId: 'node-2', force: true } },
      },
    ],
    [
      'out-of-range pointer coordinate',
      {
        ...BASE_REQUEST,
        tool: { name: 'pointer', arguments: { elementId: 'element-1', x: 1.01 } },
      },
    ],
    [
      'zero highlight duration',
      {
        ...BASE_REQUEST,
        tool: { name: 'highlight', arguments: { elementId: 'element-1', durationMs: 0 } },
      },
    ],
    [
      'oversized board content',
      {
        ...BASE_REQUEST,
        tool: { name: 'board_text', arguments: { content: 'x'.repeat(2_001), x: 0, y: 0 } },
      },
    ],
  ])('rejects %s with no command', async (_case, body) => {
    const response = await requestTool(body);

    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_TOOL_REQUEST' },
    });
  });
});
