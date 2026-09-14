import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@livecourse/storage';
import { describe, expect, it, vi } from 'vitest';

import { teachingActionSchema, type TeachingAction } from '@/lib/livecourse/domain';
import {
  createTeachingActionRepository,
  type TeachingActionRepository,
} from '@/lib/livecourse/session/action-repository';
import {
  ClassroomPresentationError,
  ClassroomStateError,
  createClassroomController,
  readClassroomActionAuthority,
} from '@/lib/livecourse/session/controller';

function action(sequence = 0, overrides: Partial<TeachingAction> = {}): TeachingAction {
  return teachingActionSchema.parse({
    schemaVersion: 1,
    id: `action-${sequence}`,
    courseId: 'course-1',
    lessonId: 'lesson-1',
    nodeId: `node:scene-${sequence + 1}`,
    sequence,
    timestamp: `2026-08-10T08:0${sequence}:00.000Z`,
    idempotencyKey: `request-${sequence}`,
    type: 'avatar.look_at',
    payload: { target: 'slides' },
    ...overrides,
  });
}

type LessonRetryAction = Extract<TeachingAction, { type: 'lesson.retry' }>;

function retryAction(sequence = 0, overrides: Partial<LessonRetryAction> = {}): LessonRetryAction {
  const parsed = teachingActionSchema.parse({
    schemaVersion: 1,
    id: `lesson-retry-${sequence}`,
    courseId: 'course-1',
    lessonId: 'lesson-1',
    nodeId: `node:scene-${sequence + 1}`,
    sequence,
    timestamp: `2026-08-10T08:0${sequence}:00.000Z`,
    idempotencyKey: `lesson.retry:${sequence}`,
    type: 'lesson.retry',
    payload: {},
    ...overrides,
  });
  if (parsed.type !== 'lesson.retry') throw new Error('Expected a lesson.retry fixture');
  return parsed;
}

function repository(): TeachingActionRepository {
  return createTeachingActionRepository({
    store: new BrowserRuntimeStore({ dbName: `classroom-controller-${crypto.randomUUID()}` }),
    stageId: 'stage-1',
    learnerId: 'learner-1',
    courseId: 'course-1',
    lessonId: 'lesson-1',
  });
}

describe('ClassroomController', () => {
  it('selects the strongest authority marker across nested rollback errors', () => {
    expect(
      readClassroomActionAuthority({
        errors: [{ authority: 'not_committed' }, { authority: 'committed' }],
      }),
    ).toBe('committed');
    expect(
      readClassroomActionAuthority({
        cause: { errors: [{ authority: 'committed' }, { authority: 'uncertain' }] },
      }),
    ).toBe('uncertain');
  });

  it('applies presentation, commits the action, then publishes it', async () => {
    const durable = repository();
    const order: string[] = [];
    const tracked: TeachingActionRepository = {
      load: () => durable.load(),
      inspect: (input) => durable.inspect(input),
      append: async (input) => {
        order.push('commit');
        return durable.append(input);
      },
      destroy: () => durable.destroy(),
    };
    const controller = createClassroomController({
      repository: tracked,
      applyPresentation: () => {
        order.push('presentation');
        return { success: true, data: { handled: true } };
      },
      publish: () => {
        order.push('publish');
      },
    });

    await controller.load();
    const result = await controller.dispatch(action());

    expect(order).toEqual(['presentation', 'commit', 'publish']);
    expect(result).toMatchObject({
      duplicate: false,
      presentationHandled: true,
      recoveryPoint: { currentNodeId: 'node:scene-1', lastSequence: 0 },
    });
  });

  it('does not commit or publish when presentation application fails', async () => {
    const durable = repository();
    const publish = vi.fn();
    const controller = createClassroomController({
      repository: durable,
      applyPresentation: () => ({ success: false, error: 'missing scene' }),
      publish,
    });

    await controller.load();
    await expect(controller.dispatch(action())).rejects.toEqual(
      expect.objectContaining<ClassroomPresentationError>({
        name: 'ClassroomPresentationError',
        message: 'missing scene',
        cause: undefined,
      }),
    );
    await expect(durable.load()).resolves.toEqual({
      actions: [],
      currentNodeId: null,
      lastSequence: -1,
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps the committed action and exposes a non-authoritative publish error', async () => {
    const durable = repository();
    const controller = createClassroomController({
      repository: durable,
      applyPresentation: () => ({ success: true }),
      publish: () => {
        throw new Error('avatar unavailable');
      },
    });

    await controller.load();
    const result = await controller.dispatch(action());

    expect(result.publishError).toEqual(new Error('avatar unavailable'));
    expect(result.recoveryPoint).toEqual({ currentNodeId: 'node:scene-1', lastSequence: 0 });
    await expect(durable.load()).resolves.toMatchObject({
      actions: [action()],
      lastSequence: 0,
    });
  });

  it('does not reapply or republish a completed idempotent retry', async () => {
    const durable = repository();
    const applyPresentation = vi.fn(() => ({ success: true as const }));
    const publish = vi.fn();
    const controller = createClassroomController({
      repository: durable,
      applyPresentation,
      publish,
    });

    await controller.load();
    await controller.dispatch(action());
    const duplicate = await controller.dispatch(
      action(1, {
        id: 'retry-action',
        idempotencyKey: 'request-0',
        nodeId: 'node:scene-1',
      }),
    );

    expect(duplicate).toMatchObject({ duplicate: true, presentationHandled: false });
    expect(applyPresentation).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    await expect(controller.getRecoveryPoint()).resolves.toEqual({
      currentNodeId: 'node:scene-1',
      lastSequence: 0,
    });
  });

  it('does not publish when the repository detects a duplicate during commit', async () => {
    const input = action();
    const append = vi.fn(async () => ({
      action: input,
      duplicate: true,
      recoveryPoint: { currentNodeId: input.nodeId, lastSequence: input.sequence },
    }));
    const publish = vi.fn();
    const controller = createClassroomController({
      repository: {
        load: async () => ({ actions: [], currentNodeId: null, lastSequence: -1 }),
        inspect: async () => ({
          status: 'new',
          action: input,
          snapshot: { actions: [], currentNodeId: null, lastSequence: -1 },
        }),
        append,
        destroy: async () => {},
      },
      applyPresentation: () => ({ success: true, data: { handled: true } }),
      publish,
    });

    await controller.load();
    await expect(controller.dispatch(input)).resolves.toMatchObject({
      action: input,
      duplicate: true,
      presentationHandled: true,
    });
    expect(append).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it('migrates local state and publishes once when presentation commit fails, then settles on duplicate retry', async () => {
    const durable = repository();
    const publish = vi.fn();
    const applyPresentation = vi.fn();
    let commitAttempts = 0;
    applyPresentation.mockImplementation(() => ({
      success: true as const,
      commit: async () => {
        commitAttempts += 1;
        if (commitAttempts === 1) throw new Error('presentation transaction still open');
      },
      data: { handled: true },
    }));
    const controller = createClassroomController({
      repository: durable,
      applyPresentation,
      publish,
    });

    await controller.load();
    await expect(controller.dispatch(action())).rejects.toMatchObject({
      name: 'ClassroomPresentationCommitError',
      published: true,
    });
    // W is authoritative and local state moved even though the commit hook
    // failed. The event bus was attempted exactly once before surfacing it.
    await expect(durable.load()).resolves.toMatchObject({
      actions: [action()],
      currentNodeId: 'node:scene-1',
      lastSequence: 0,
    });
    expect(controller.getState()).toBe('teaching');
    expect(publish).toHaveBeenCalledTimes(1);

    const retry = await controller.dispatch(
      action(1, {
        id: 'retry-after-commit-failure',
        idempotencyKey: 'request-0',
        nodeId: 'node:scene-1',
      }),
    );
    expect(retry).toMatchObject({ duplicate: true, presentationHandled: true });
    expect(commitAttempts).toBe(2);
    expect(applyPresentation).toHaveBeenCalledTimes(1);
    // Retrying the idempotency key closes the presentation transaction but
    // never republishes the already-attempted W action.
    expect(publish).toHaveBeenCalledTimes(1);
    await expect(durable.load()).resolves.toMatchObject({ lastSequence: 0 });
  });

  it('preserves checking as the pause/resume origin and hydrates it from W', async () => {
    const durable = repository();
    const controller = createClassroomController({
      repository: durable,
      applyPresentation: () => ({ success: true as const }),
      publish: () => undefined,
    });

    await controller.load();
    await controller.dispatch(
      action(0, {
        type: 'checkpoint.open',
        payload: { checkpointId: 'checkpoint-1' },
      }),
    );
    expect(controller.getState()).toBe('checking');
    await controller.dispatch(
      action(1, {
        type: 'lesson.pause',
        payload: {},
      }),
    );
    expect(controller.getState()).toBe('paused');
    await controller.dispatch(
      action(2, {
        type: 'lesson.resume',
        payload: {},
      }),
    );
    expect(controller.getState()).toBe('checking');

    const reloaded = createClassroomController({
      repository: durable,
      applyPresentation: () => ({ success: true as const }),
      publish: () => undefined,
    });
    await reloaded.load();
    expect(reloaded.getState()).toBe('checking');
  });

  it('requires and accepts the explicit checkpoint open before a submission', async () => {
    const durable = repository();
    const controller = createClassroomController({
      repository: durable,
      applyPresentation: () => ({ success: true as const }),
      publish: () => undefined,
    });

    await controller.load();
    await expect(
      controller.dispatch(
        action(0, {
          type: 'checkpoint.submit',
          payload: { checkpointId: 'scene:quiz-1', response: { answer: 'A' } },
        }),
      ),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(controller.getState()).toBe('teaching');

    await expect(
      controller.dispatch(
        action(0, {
          type: 'checkpoint.open',
          id: 'checkpoint-open',
          idempotencyKey: 'checkpoint.open:attempt-1',
          payload: { checkpointId: 'scene:quiz-1' },
        }),
      ),
    ).resolves.toMatchObject({ state: 'checking', duplicate: false });

    await expect(
      controller.dispatch(
        action(1, {
          type: 'checkpoint.submit',
          id: 'checkpoint-submit',
          idempotencyKey: 'action:quiz-review:attempt-1',
          payload: { checkpointId: 'scene:quiz-1', response: { answer: 'A' } },
        }),
      ),
    ).resolves.toMatchObject({ state: 'checking', duplicate: false });

    await expect(durable.load()).resolves.toMatchObject({
      actions: [
        expect.objectContaining({ type: 'checkpoint.open' }),
        expect.objectContaining({ type: 'checkpoint.submit' }),
      ],
      lastSequence: 1,
    });
  });

  it('accepts lesson.retry in teaching and checking without changing lifecycle state', async () => {
    const durable = repository();
    const applyPresentation = vi.fn(() => ({ success: true as const }));
    const controller = createClassroomController({
      repository: durable,
      applyPresentation,
      publish: () => undefined,
    });

    await controller.load();
    await controller.dispatch(action(0, { nodeId: 'node:scene-1' }));

    await expect(
      controller.dispatch(retryAction(1, { nodeId: 'node:scene-1' })),
    ).resolves.toMatchObject({
      duplicate: false,
      state: 'teaching',
      recoveryPoint: { currentNodeId: 'node:scene-1', lastSequence: 1 },
    });

    await controller.dispatch(
      action(2, {
        type: 'checkpoint.open',
        nodeId: 'node:scene-1',
        payload: { checkpointId: 'checkpoint-1' },
      }),
    );
    expect(controller.getState()).toBe('checking');

    await expect(
      controller.dispatch(retryAction(3, { nodeId: 'node:scene-1' })),
    ).resolves.toMatchObject({
      duplicate: false,
      state: 'checking',
      recoveryPoint: { currentNodeId: 'node:scene-1', lastSequence: 3 },
    });

    expect(applyPresentation).toHaveBeenCalledTimes(4);
    await expect(durable.load()).resolves.toMatchObject({
      actions: [
        expect.objectContaining({ type: 'avatar.look_at' }),
        expect.objectContaining({ type: 'lesson.retry' }),
        expect.objectContaining({ type: 'checkpoint.open' }),
        expect.objectContaining({ type: 'lesson.retry' }),
      ],
      currentNodeId: 'node:scene-1',
      lastSequence: 3,
    });
  });

  it('rejects lesson.retry when its node does not match the current W node', async () => {
    const durable = repository();
    const applyPresentation = vi.fn(() => ({ success: true as const }));
    const controller = createClassroomController({
      repository: durable,
      applyPresentation,
      publish: () => undefined,
    });

    await controller.load();
    await controller.dispatch(action(0, { nodeId: 'node:scene-1' }));

    await expect(controller.dispatch(retryAction(1, { nodeId: 'node:scene-2' }))).rejects.toEqual(
      expect.objectContaining<ClassroomStateError>({
        name: 'ClassroomStateError',
        message: 'lesson.retry must target the current lesson node',
      }),
    );
    expect(controller.getState()).toBe('teaching');
    expect(applyPresentation).toHaveBeenCalledTimes(1);
    await expect(durable.load()).resolves.toMatchObject({
      actions: [expect.objectContaining({ type: 'avatar.look_at' })],
      currentNodeId: 'node:scene-1',
      lastSequence: 0,
    });
  });

  it('rejects lesson.retry while loading', async () => {
    const durable = repository();
    const applyPresentation = vi.fn(() => ({ success: true as const }));
    const controller = createClassroomController({
      repository: durable,
      applyPresentation,
      publish: () => undefined,
    });

    await expect(
      controller.dispatch(retryAction(0, { nodeId: 'node:scene-1' })),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(controller.getState()).toBe('loading');
    expect(applyPresentation).not.toHaveBeenCalled();
    await expect(durable.load()).resolves.toMatchObject({ actions: [], lastSequence: -1 });
  });

  it('rejects lesson.retry while paused', async () => {
    const durable = repository();
    const applyPresentation = vi.fn(() => ({ success: true as const }));
    const controller = createClassroomController({
      repository: durable,
      applyPresentation,
      publish: () => undefined,
    });

    await controller.load();
    await controller.dispatch(action(0, { nodeId: 'node:scene-1' }));
    await controller.dispatch(
      action(1, {
        type: 'lesson.pause',
        nodeId: 'node:scene-1',
        payload: {},
      }),
    );

    await expect(
      controller.dispatch(retryAction(2, { nodeId: 'node:scene-1' })),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(controller.getState()).toBe('paused');
    expect(applyPresentation).toHaveBeenCalledTimes(2);
    await expect(durable.load()).resolves.toMatchObject({ lastSequence: 1 });
  });

  it('rejects lesson.retry while interrupted', async () => {
    const durable = repository();
    const applyPresentation = vi.fn(() => ({ success: true as const }));
    const controller = createClassroomController({
      repository: durable,
      applyPresentation,
      publish: () => undefined,
    });

    await controller.load();
    await controller.dispatch(action(0, { nodeId: 'node:scene-1' }));
    await controller.dispatch(
      action(1, {
        type: 'lesson.interrupt',
        nodeId: 'node:scene-1',
        payload: { question: '请再解释一次' },
      }),
    );

    await expect(
      controller.dispatch(retryAction(2, { nodeId: 'node:scene-1' })),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(controller.getState()).toBe('interrupted');
    expect(applyPresentation).toHaveBeenCalledTimes(2);
    await expect(durable.load()).resolves.toMatchObject({ lastSequence: 1 });
  });

  it('rejects lesson.retry while replaying', async () => {
    const durable = repository();
    await durable.append(action(0, { nodeId: 'node:scene-1' }));
    await durable.append(
      action(1, {
        type: 'lesson.relisten_start',
        nodeId: 'node:scene-1',
        payload: { targetNodeId: 'node:scene-1' },
      }),
    );
    const applyPresentation = vi.fn(() => ({ success: true as const }));
    const controller = createClassroomController({
      repository: durable,
      applyPresentation,
      publish: () => undefined,
    });

    await controller.load();
    expect(controller.getState()).toBe('replaying');
    await expect(
      controller.dispatch(retryAction(2, { nodeId: 'node:scene-1' })),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(controller.getState()).toBe('replaying');
    expect(applyPresentation).not.toHaveBeenCalled();
    await expect(durable.load()).resolves.toMatchObject({ lastSequence: 1 });
  });

  it('deduplicates lesson.retry by idempotency key without appending twice', async () => {
    const durable = repository();
    const append = vi.fn((input: TeachingAction) => durable.append(input));
    const tracked: TeachingActionRepository = {
      load: () => durable.load(),
      inspect: (input) => durable.inspect(input),
      append,
      destroy: () => durable.destroy(),
    };
    const applyPresentation = vi.fn(() => ({ success: true as const }));
    const publish = vi.fn();
    const controller = createClassroomController({
      repository: tracked,
      applyPresentation,
      publish,
    });

    await controller.load();
    await controller.dispatch(action(0, { nodeId: 'node:scene-1' }));
    await controller.dispatch(
      retryAction(1, {
        id: 'lesson-retry-first',
        idempotencyKey: 'lesson.retry:stable-key',
        nodeId: 'node:scene-1',
      }),
    );
    const duplicate = await controller.dispatch(
      retryAction(2, {
        id: 'lesson-retry-duplicate',
        idempotencyKey: 'lesson.retry:stable-key',
        nodeId: 'node:scene-1',
      }),
    );

    expect(duplicate).toMatchObject({
      duplicate: true,
      presentationHandled: false,
      state: 'teaching',
    });
    expect(append).toHaveBeenCalledTimes(2);
    expect(applyPresentation).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(2);
    await expect(durable.load()).resolves.toMatchObject({
      actions: [
        expect.objectContaining({ id: 'action-0' }),
        expect.objectContaining({
          id: 'lesson-retry-first',
          idempotencyKey: 'lesson.retry:stable-key',
        }),
      ],
      lastSequence: 1,
    });
  });

  it('rejects ordinary presentation actions while loading or paused without touching W', async () => {
    const durable = repository();
    const applyPresentation = vi.fn(() => ({ success: true as const }));
    const publish = vi.fn();
    const controller = createClassroomController({
      repository: durable,
      applyPresentation,
      publish,
    });

    await expect(controller.dispatch(action())).rejects.toBeInstanceOf(ClassroomStateError);
    expect(applyPresentation).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    await expect(durable.load()).resolves.toMatchObject({ actions: [], lastSequence: -1 });

    await controller.load();
    await controller.dispatch(action(0, { type: 'lesson.pause', payload: {} }));
    await expect(
      controller.dispatch(
        action(1, { id: 'blocked', idempotencyKey: 'blocked', nodeId: 'node:scene-1' }),
      ),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(controller.getState()).toBe('paused');
    expect(applyPresentation).toHaveBeenCalledTimes(1);
    await expect(durable.load()).resolves.toMatchObject({ lastSequence: 0 });
  });

  it('hydrates a duplicate command into the local state machine without republishing it', async () => {
    const durable = repository();
    const input = action(0, {
      type: 'lesson.interrupt',
      payload: { question: '为什么？' },
    });
    // Another coordinator already committed the command before this instance
    // saw it. The local controller must still reflect the authoritative W
    // transition, while the event bus must not receive a second publication.
    await durable.append(input);
    const publish = vi.fn();
    const controller = createClassroomController({
      repository: durable,
      applyPresentation: vi.fn(() => ({ success: true as const })),
      publish,
    });

    await controller.load();
    const result = await controller.dispatch(input);

    expect(result.duplicate).toBe(true);
    expect(result.state).toBe('interrupted');
    expect(controller.getState()).toBe('interrupted');
    expect(publish).not.toHaveBeenCalled();
  });

  it('rolls back a presentation when the action append is rejected', async () => {
    const input = action();
    const calls: string[] = [];
    const durable = repository();
    const controller = createClassroomController({
      repository: {
        load: () => durable.load(),
        inspect: (candidate) => durable.inspect(candidate),
        append: async () => {
          throw new Error('append rejected');
        },
        destroy: () => durable.destroy(),
      },
      applyPresentation: () => ({
        success: true as const,
        rollback: () => {
          calls.push('rollback');
        },
      }),
      publish: () => {
        calls.push('publish');
      },
    });

    await controller.load();
    await expect(controller.dispatch(input)).rejects.toThrow('append rejected');
    expect(calls).toEqual(['rollback']);
    await expect(durable.load()).resolves.toEqual({
      actions: [],
      currentNodeId: null,
      lastSequence: -1,
    });
  });

  it('rolls back a partially applied presentation reported as unsuccessful', async () => {
    const input = action();
    const calls: string[] = [];
    const durable = repository();
    const controller = createClassroomController({
      repository: durable,
      applyPresentation: () => ({
        success: false as const,
        error: 'scene missing',
        rollback: () => {
          calls.push('rollback');
        },
      }),
      publish: () => {
        calls.push('publish');
      },
    });

    await controller.load();
    await expect(controller.dispatch(input)).rejects.toThrow('scene missing');
    expect(calls).toEqual(['rollback']);
    await expect(durable.load()).resolves.toEqual({
      actions: [],
      currentNodeId: null,
      lastSequence: -1,
    });
  });

  it('serializes concurrent dispatch calls so adjacent sequences commit in order', async () => {
    const durable = repository();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const seen: number[] = [];
    const controller = createClassroomController({
      repository: durable,
      applyPresentation: async (input) => {
        seen.push(input.sequence);
        if (input.sequence === 0) {
          markFirstStarted();
          await firstBlocked;
        }
        return { success: true };
      },
      publish: () => undefined,
    });

    await controller.load();
    const first = controller.dispatch(action(0));
    const second = controller.dispatch(action(1));
    await firstStarted;
    expect(seen).toEqual([0]);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(seen).toEqual([0, 1]);
    await expect(controller.getRecoveryPoint()).resolves.toEqual({
      currentNodeId: 'node:scene-2',
      lastSequence: 1,
    });
  });
});
