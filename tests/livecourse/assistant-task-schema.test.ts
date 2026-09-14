import { describe, expect, it } from 'vitest';

import {
  AssistantTaskIdCollisionError,
  AssistantTaskService,
  assistantTaskSchema,
  assistantTaskSnapshotSchema,
  type AssistantTask,
} from '@/lib/livecourse/domain';

const base: AssistantTask = {
  schemaVersion: 1,
  id: 'task-1',
  courseId: 'course-1',
  lessonId: 'lesson-1',
  nodeId: 'node-1',
  sceneId: 'scene-1',
  version: 1,
  kind: 'draft_board_note',
  delegatedBy: 'teacher-1',
  assistantId: 'assistant-1',
  inputRefs: ['source-1'],
  idempotencyKey: 'realtime:call-1',
  status: 'queued',
  createdAt: '2026-08-17T01:00:00.000Z',
  updatedAt: '2026-08-17T01:00:00.000Z',
};

describe('AssistantTask schema', () => {
  it('requires classroom context, bounded refs, and explicit terminal payloads', () => {
    expect(
      assistantTaskSchema.safeParse({ ...base, inputRefs: ['raw prompt with spaces'] }).success,
    ).toBe(false);
    expect(assistantTaskSchema.safeParse({ ...base, status: 'succeeded' }).success).toBe(false);
    expect(
      assistantTaskSchema.safeParse({ ...base, status: 'failed', failureReason: 'bounded failure' })
        .success,
    ).toBe(true);
  });

  it('rejects a snapshot with duplicate task identity', () => {
    expect(
      assistantTaskSnapshotSchema.safeParse({
        schemaVersion: 1,
        tasks: [base, { ...base, id: 'task-2' }],
        events: [],
      }).success,
    ).toBe(false);
  });

  it('reports a forced generated-id collision instead of overwriting a task', () => {
    const service = new AssistantTaskService({
      idFactory: () => 'forced-task-id',
      now: () => '2026-08-17T01:00:00.000Z',
    });
    const first = service.create({
      schemaVersion: 1,
      courseId: 'course-1',
      lessonId: 'lesson-1',
      nodeId: 'node-1',
      sceneId: 'scene-1',
      kind: 'draft_board_note',
      delegatedBy: 'teacher-1',
      assistantId: 'assistant-1',
      inputRefs: ['source-1'],
      idempotencyKey: 'realtime:course-1:call-1',
    });

    expect(() =>
      service.create({
        ...first,
        idempotencyKey: 'realtime:course-2:call-1',
        courseId: 'course-2',
      }),
    ).toThrowError(AssistantTaskIdCollisionError);
    expect(service.list()).toHaveLength(1);
    expect(service.get(first.id).courseId).toBe('course-1');
  });
});
