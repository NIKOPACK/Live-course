import { describe, expect, it } from 'vitest';

import { AssistantTaskService, recoverAssistantTaskSnapshot } from '@/lib/livecourse/domain';

function create() {
  const service = new AssistantTaskService({ now: () => '2026-08-17T01:00:00.000Z' });
  const task = service.create({
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
  service.start(task.id);
  return { service, id: task.id };
}

describe('AssistantTask recovery', () => {
  it('explicitly requeues unfinished work and preserves terminal uniqueness', () => {
    const { service, id } = create();
    const recovered = recoverAssistantTaskSnapshot(service.snapshot(), {
      now: () => '2026-08-17T02:00:00.000Z',
    });
    expect(recovered.get(id)).toMatchObject({ status: 'queued', version: 3 });
    expect(recovered.snapshot().events.at(-1)).toMatchObject({ type: 'requeued', to: 'queued' });
  });

  it('keeps a succeeded task terminal across recovery', () => {
    const service = new AssistantTaskService({ now: () => '2026-08-17T01:00:00.000Z' });
    const task = service.create({
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
    service.start(task.id);
    service.succeed(task.id, { kind: 'draft_board_note', summary: 'done', content: 'done' });
    const recovered = recoverAssistantTaskSnapshot(service.snapshot());
    expect(recovered.get(task.id).status).toBe('succeeded');
    expect(() => recovered.start(task.id)).toThrow();
  });
});
