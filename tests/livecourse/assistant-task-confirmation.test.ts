import { describe, expect, it } from 'vitest';

import { AssistantTaskService } from '@/lib/livecourse/domain';
import { AssistantTaskConfirmation } from '@/lib/livecourse/realtime/assistant-task-runner';

describe('AssistantTaskConfirmation', () => {
  it('tracks confirmation as pending until the classroom acknowledges application', () => {
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
    service.succeed(task.id, {
      kind: 'draft_board_note',
      summary: 'proposal',
      content: 'approved note',
    });
    expect(service.get(task.id).confirmation).toBeUndefined();
    expect(() =>
      new AssistantTaskConfirmation(service, {
        now: () => '2026-08-17T02:00:00.000Z',
        authorize: (_task, confirmedBy) => confirmedBy === 'teacher-1',
      }).confirm(task.id, 'teacher-2'),
    ).toThrow(/not authorized/);
    expect(service.get(task.id).confirmation).toBeUndefined();
    const confirmed = new AssistantTaskConfirmation(
      service,
      () => '2026-08-17T02:00:00.000Z',
    ).confirm(task.id, 'teacher-1');
    expect(confirmed.command.type).toBe('board.apply');
    expect(confirmed.task.confirmation?.confirmedBy).toBe('teacher-1');
    expect(confirmed.task.confirmation?.applicationStatus).toBe('pending');

    const applied = new AssistantTaskConfirmation(
      service,
      () => '2026-08-17T02:01:00.000Z',
    ).markApplied(task.id, 'teacher-1', confirmed.command.idempotencyKey);
    expect(applied.confirmation).toMatchObject({
      applicationStatus: 'applied',
      appliedAt: '2026-08-17T02:01:00.000Z',
    });
  });

  it('keeps a failed dispatch retryable with the same command idempotency key', async () => {
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
    service.succeed(task.id, {
      kind: 'draft_board_note',
      summary: 'proposal',
      content: 'approved note',
    });
    const confirmation = new AssistantTaskConfirmation(service, () => '2026-08-17T02:00:00.000Z');
    const first = confirmation.confirm(task.id, 'teacher-1');

    await expect(
      confirmation.confirmAndDispatch(task.id, 'teacher-1', async () => {
        throw new Error('classroom unavailable');
      }),
    ).rejects.toThrow('classroom unavailable');
    expect(service.get(task.id).confirmation?.applicationStatus).toBe('pending');

    const dispatched: string[] = [];
    const retried = await confirmation.confirmAndDispatch(task.id, 'teacher-1', async (command) => {
      dispatched.push(command.idempotencyKey);
    });
    expect(dispatched).toEqual([first.command.idempotencyKey]);
    expect(retried.task.confirmation?.applicationStatus).toBe('applied');
  });
});
