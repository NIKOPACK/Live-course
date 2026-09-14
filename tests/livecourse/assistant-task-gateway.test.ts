import { describe, expect, it } from 'vitest';

import { AssistantTaskService } from '@/lib/livecourse/domain';
import {
  AssistantTaskGateway,
  type ActiveClassroom,
} from '@/lib/livecourse/realtime/server/assistant-task-gateway';

const input = {
  courseId: 'course-1',
  lessonId: 'lesson-1',
  nodeId: 'node-1',
  sceneId: 'scene-1',
  callId: 'call-1',
  assistantId: 'assistant-1',
  kind: 'draft_board_note' as const,
  inputRefs: ['source-1'],
  delegatedBy: 'teacher-1',
};

function setup() {
  let active: ActiveClassroom | null = {
    courseId: 'course-1',
    lessonId: 'lesson-1',
    nodeId: 'node-1',
    sceneId: 'scene-1',
    active: true,
  };
  const service = new AssistantTaskService({ now: () => '2026-08-17T01:00:00.000Z' });
  const gateway = new AssistantTaskGateway({
    taskService: service,
    getActiveClassroom: () => active,
    roster: {
      getAssistant: (id) =>
        id === 'assistant-1' ? { id, kinds: ['draft_board_note', 'suggest_next_step'] } : null,
    },
  });
  return {
    gateway,
    service,
    setActive: (value: ActiveClassroom | null) => {
      active = value;
    },
  };
}

describe('AssistantTaskGateway', () => {
  it('queues once and returns the original task for a semantic retry', () => {
    const { gateway, service } = setup();
    const first = gateway.delegate(input);
    const second = gateway.delegate(input);
    expect(second).toEqual(first);
    expect(service.list()).toHaveLength(1);
    expect(first.status).toBe('queued');
  });

  it.each([
    ['no active context', (state: ReturnType<typeof setup>) => state.setActive(null)],
    [
      'wrong node',
      (state: ReturnType<typeof setup>) =>
        state.setActive({
          courseId: 'course-1',
          lessonId: 'lesson-1',
          nodeId: 'other',
          sceneId: 'scene-1',
          active: true,
        }),
    ],
  ])('fails closed for %s', (_label, change) => {
    const state = setup();
    change(state);
    expect(() => state.gateway.delegate(input)).toThrow();
  });

  it('rejects an unrostered assistant and conflicting idempotency reuse', () => {
    const state = setup();
    expect(() => state.gateway.delegate({ ...input, assistantId: 'missing' })).toThrow(
      /not rostered/,
    );
    state.gateway.delegate(input);
    expect(() => state.gateway.delegate({ ...input, kind: 'suggest_next_step' })).toThrow(
      /idempotency conflict/,
    );
  });

  it('scopes a reused realtime call id to its course context', () => {
    let active: ActiveClassroom = {
      courseId: 'course-1',
      lessonId: 'lesson-1',
      nodeId: 'node-1',
      sceneId: 'scene-1',
      active: true,
    };
    const service = new AssistantTaskService({ now: () => '2026-08-17T01:00:00.000Z' });
    const gateway = new AssistantTaskGateway({
      taskService: service,
      getActiveClassroom: () => active,
      roster: {
        getAssistant: (id) => (id === 'assistant-1' ? { id, kinds: ['draft_board_note'] } : null),
      },
    });

    const firstTask = gateway.delegate(input);
    active = { ...active, courseId: 'course-2' };
    const secondTask = gateway.delegate({ ...input, courseId: 'course-2' });

    expect(secondTask.id).not.toBe(firstTask.id);
    expect(service.list()).toHaveLength(2);
  });
});
