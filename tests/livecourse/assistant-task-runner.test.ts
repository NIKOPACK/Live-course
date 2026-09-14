import { describe, expect, it } from 'vitest';

import { AssistantTaskService } from '@/lib/livecourse/domain';
import { AssistantTaskRunner } from '@/lib/livecourse/realtime/assistant-task-runner';

function taskService() {
  return new AssistantTaskService({ now: () => '2026-08-17T01:00:00.000Z' });
}
function create(service: AssistantTaskService) {
  return service.create({
    schemaVersion: 1,
    courseId: 'course-1',
    lessonId: 'lesson-1',
    nodeId: 'node-1',
    sceneId: 'scene-1',
    kind: 'draft_board_note',
    delegatedBy: 'teacher-1',
    assistantId: 'assistant-1',
    inputRefs: ['source-1'],
    idempotencyKey: 'key-1',
  });
}

describe('AssistantTaskRunner', () => {
  it('uses a fixed capability and records structured success', async () => {
    const service = taskService();
    const task = create(service);
    const seen: string[] = [];
    const runner = new AssistantTaskRunner({
      service,
      executor: {
        execute: async (_task, capability) => {
          seen.push(capability);
          return { kind: 'draft_board_note', summary: 'note', content: 'approved note' };
        },
      },
    });
    await expect(runner.run(task.id)).resolves.toMatchObject({
      status: 'succeeded',
      result: { kind: 'draft_board_note' },
    });
    await expect(runner.run(task.id)).resolves.toMatchObject({
      status: 'succeeded',
      result: { summary: 'note' },
    });
    expect(seen).toEqual(['draft_classroom_note']);
    expect(service.snapshot().events.filter((event) => event.type === 'succeeded')).toHaveLength(1);
  });

  it('turns executor failures into bounded failed state and never fake success', async () => {
    const service = taskService();
    const task = create(service);
    const runner = new AssistantTaskRunner({
      service,
      executor: {
        execute: async () => {
          throw new Error('provider unavailable\nsecret');
        },
      },
    });
    await expect(runner.run(task.id)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'provider unavailable secret',
    });
  });
});
