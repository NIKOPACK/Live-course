import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@livecourse/storage';
import { describe, expect, it, vi } from 'vitest';

import {
  lessonPlanSchema,
  teachingActionSchema,
  type TeachingAction,
} from '@/lib/livecourse/domain';
import {
  createTeachingActionRepository,
  livecourseActionSessionId,
  type TeachingActionRepository,
} from '@/lib/livecourse/session/action-repository';
import {
  finalizeCommittedClassroomDispatch,
  LiveCourseActionRuntime,
  resolveRecoverySceneId,
} from '@/lib/livecourse/session/context';
import {
  createClassroomController,
  type ClassroomDispatchResult,
} from '@/lib/livecourse/session/controller';
import type { CourseStateSnapshot } from '@/lib/livecourse/session/course-state-snapshot';

function action(overrides: Partial<TeachingAction> = {}): TeachingAction {
  return teachingActionSchema.parse({
    schemaVersion: 1,
    id: 'action-0',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    nodeId: 'node:scene-1',
    sequence: 0,
    timestamp: '2026-08-10T08:00:00.000Z',
    idempotencyKey: 'request-0',
    type: 'avatar.look_at',
    payload: { target: 'slides' },
    ...overrides,
  });
}

function setup(
  getFallbackNodeId: () => string | null = () => 'node:scene-fallback',
  assertActive?: () => void,
) {
  const store = new BrowserRuntimeStore({
    dbName: `livecourse-context-${crypto.randomUUID()}`,
  });
  const repository: TeachingActionRepository = createTeachingActionRepository({
    store,
    stageId: 'stage-1',
    learnerId: 'learner-1',
    courseId: 'course-1',
    lessonId: 'lesson-1',
  });
  const applyPresentation = vi.fn(() => ({ success: true as const, data: { handled: true } }));
  const publish = vi.fn();
  const controller = createClassroomController({
    repository,
    applyPresentation,
    publish,
  });
  let nextId = 0;
  const runtime = new LiveCourseActionRuntime({
    controller,
    courseId: 'course-1',
    lessonId: 'lesson-1',
    getFallbackNodeId,
    assertActive,
    now: () => '2026-08-10T09:00:00.000Z',
    createActionId: () => `emitted-action-${nextId++}`,
  });
  return { applyPresentation, publish, repository, runtime };
}

describe('LiveCourse session action runtime', () => {
  it('surfaces a committed authority when the working-memory projection fails', async () => {
    const committed = {
      action: action({ id: 'committed-action' }),
      duplicate: false,
      presentationHandled: true,
      recoveryPoint: { currentNodeId: 'node:scene-1', lastSequence: 0 },
      state: 'teaching',
    } satisfies ClassroomDispatchResult;
    const applyResult = vi.fn(() => ({
      action: committed.action,
      duplicate: committed.duplicate,
      presentationHandled: committed.presentationHandled,
    }));

    await expect(
      finalizeCommittedClassroomDispatch({
        dispatch: async () => committed,
        persistWorkingMemory: async () => {
          throw new Error('working-memory write failed');
        },
        applyResult,
        assertCurrent: () => undefined,
        isCurrent: () => true,
      }),
    ).rejects.toMatchObject({
      name: 'ClassroomWorkingMemoryProjectionError',
      authority: 'committed',
      result: committed,
    });
    expect(applyResult).toHaveBeenCalledWith(committed);
  });

  it('retains committed authority when the lifecycle expires after W append', async () => {
    const committed = {
      action: action({ id: 'committed-after-lifecycle' }),
      duplicate: false,
      presentationHandled: true,
      recoveryPoint: { currentNodeId: 'node:scene-1', lastSequence: 0 },
      state: 'teaching',
    } satisfies ClassroomDispatchResult;
    let assertionCount = 0;

    await expect(
      finalizeCommittedClassroomDispatch({
        dispatch: async () => committed,
        persistWorkingMemory: async () => undefined,
        applyResult: () => {
          throw new Error('read-side update should not run after expiry');
        },
        assertCurrent: () => {
          assertionCount += 1;
          if (assertionCount > 1) throw new Error('session expired');
        },
        isCurrent: () => assertionCount <= 1,
      }),
    ).rejects.toMatchObject({
      name: 'ClassroomActionCommittedError',
      authority: 'committed',
      result: committed,
    });
  });

  it('preserves an authority marker nested inside an aggregate lifecycle failure', async () => {
    const committed = {
      action: action({ id: 'committed-nested-marker' }),
      duplicate: false,
      presentationHandled: true,
      recoveryPoint: { currentNodeId: 'node:scene-1', lastSequence: 0 },
      state: 'teaching',
    } satisfies ClassroomDispatchResult;
    const nestedUncertainty = new Error('reconciliation pending');
    Object.assign(nestedUncertainty, { authority: 'uncertain' as const });
    const aggregate = new AggregateError([new Error('lifecycle race'), nestedUncertainty]);

    await expect(
      finalizeCommittedClassroomDispatch({
        dispatch: async () => committed,
        persistWorkingMemory: async () => undefined,
        applyResult: () => ({
          action: committed.action,
          duplicate: committed.duplicate,
          presentationHandled: committed.presentationHandled,
        }),
        assertCurrent: () => {
          throw aggregate;
        },
        isCurrent: () => true,
      }),
    ).rejects.toBe(aggregate);
  });

  it('rejects queued commands after the owning lifecycle expires without creating W', async () => {
    let active = true;
    const { repository, runtime } = setup(
      () => 'node:scene-current',
      () => {
        if (!active) throw new Error('session expired');
      },
    );

    active = false;
    await expect(
      runtime.dispatch(action({ id: 'stale-action', idempotencyKey: 'stale-request' })),
    ).rejects.toThrow('session expired');
    await expect(repository.load()).resolves.toEqual({
      actions: [],
      currentNodeId: null,
      lastSequence: -1,
    });
  });

  it('loads a durable recovery point without applying or publishing a new action', async () => {
    const { applyPresentation, publish, repository, runtime } = setup();
    const persisted = action();
    await repository.append(persisted);

    await expect(runtime.load()).resolves.toEqual({
      actions: [persisted],
      currentNodeId: 'node:scene-1',
      lastSequence: 0,
    });
    expect(applyPresentation).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    await expect(repository.load()).resolves.toMatchObject({ actions: [persisted] });
  });

  it('serializes concurrent emits and derives every sequence from the latest durable recovery', async () => {
    const { applyPresentation, publish, repository, runtime } = setup(() => 'node:scene-current');

    const results = await Promise.all([
      runtime.emit({ type: 'avatar.look_at', payload: { target: 'slides' } }),
      runtime.emit({ type: 'avatar.expression', payload: { expression: 'think' } }),
      runtime.emit({ type: 'lesson.pause', payload: {} }),
    ]);

    expect(results.map((result) => result.action.sequence)).toEqual([0, 1, 2]);
    expect(results.map((result) => result.action.nodeId)).toEqual([
      'node:scene-current',
      'node:scene-current',
      'node:scene-current',
    ]);
    await expect(repository.load()).resolves.toMatchObject({
      lastSequence: 2,
      currentNodeId: 'node:scene-current',
    });
    expect(applyPresentation).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('prefers the recovered node over mutable Stage playback state when emitting', async () => {
    const getFallbackNodeId = vi.fn(() => 'node:scene-ui');
    const { repository, runtime } = setup(getFallbackNodeId);
    await repository.append(action({ nodeId: 'node:scene-recovered' }));

    const result = await runtime.emit({
      type: 'avatar.expression',
      payload: { expression: 'happy' },
    });

    expect(result.action).toMatchObject({
      nodeId: 'node:scene-recovered',
      sequence: 1,
    });
    expect(getFallbackNodeId).not.toHaveBeenCalled();
  });

  it('routes externally constructed actions through the classroom controller', async () => {
    const { applyPresentation, publish, repository, runtime } = setup();
    const input = action();

    await expect(runtime.dispatch(input)).resolves.toMatchObject({
      action: input,
      duplicate: false,
      presentationHandled: true,
      recoveryPoint: { currentNodeId: input.nodeId, lastSequence: 0 },
    });
    expect(applyPresentation).toHaveBeenCalledWith(input);
    expect(publish).toHaveBeenCalledWith(input);
    await expect(repository.load()).resolves.toMatchObject({ actions: [input] });
  });

  it('routes lesson.complete_node through the serialized runtime queue', async () => {
    const store = new BrowserRuntimeStore({
      dbName: `livecourse-context-${crypto.randomUUID()}`,
    });
    const repository: TeachingActionRepository = createTeachingActionRepository({
      store,
      stageId: 'stage-1',
      learnerId: 'learner-1',
      courseId: 'course-1',
      lessonId: 'lesson-1',
    });
    // 教师 speech 与动作均成功结束（已提交）。
    await repository.append(
      action({
        id: 'speech-start-1',
        type: 'avatar.speech_start',
        payload: { text: '讲授。' },
      }),
    );
    await repository.append(action({ id: 'teach-1', sequence: 1, idempotencyKey: 'request-1' }));
    await repository.append(
      action({
        id: 'speech-end-1',
        sequence: 2,
        idempotencyKey: 'request-2',
        type: 'avatar.speech_end',
        payload: {},
      }),
    );

    const persisted: { completedNodeIds: readonly string[] | null } = { completedNodeIds: null };
    const publishEvent = vi.fn();
    const controller = createClassroomController({
      repository,
      applyPresentation: () => ({ success: true }),
      publish: () => undefined,
      completion: {
        classroomSessionId: livecourseActionSessionId({
          stageId: 'stage-1',
          learnerId: 'learner-1',
          courseId: 'course-1',
          lessonId: 'lesson-1',
        }),
        courseId: 'course-1',
        lessonId: 'lesson-1',
        lessonPlan: lessonPlanSchema.parse({
          schemaVersion: 1,
          id: 'lesson-plan:stage-1',
          courseId: 'course-1',
          stageId: 'stage-1',
          title: 'Lesson',
          version: 1,
          status: 'approved',
          createdAt: '2026-08-10T08:00:00.000Z',
          goals: [],
          nodes: [
            {
              id: 'node:scene-1',
              sceneId: 'scene-1',
              title: 'Scene 1',
              type: 'instruction',
              order: 0,
              goalIds: [],
            },
            {
              id: 'node:scene-2',
              sceneId: 'scene-2',
              title: 'Scene 2',
              type: 'instruction',
              order: 1,
              goalIds: [],
            },
          ],
        }),
        progressStore: {
          load: async () => undefined,
          saveProgress: async (input) => {
            persisted.completedNodeIds = input.progress.completedNodeIds;
            return undefined as unknown as CourseStateSnapshot;
          },
        },
        hasValidEvidence: () => false,
        publishEvent,
        now: () => '2026-08-10T09:00:00.000Z',
      },
    });
    const runtime = new LiveCourseActionRuntime({
      controller,
      courseId: 'course-1',
      lessonId: 'lesson-1',
      getFallbackNodeId: () => null,
    });

    await runtime.load();
    expect(await runtime.getClassroomState()).toBe('teaching');

    // 同一 idempotency key 的并发重试经队列串行：W / C 各推进一次。
    const [first, retry] = await Promise.all([
      runtime.completeNode({
        nodeId: 'node:scene-1',
        idempotencyKey: 'complete:scene-1:1',
        speech: { startActionId: 'speech-start-1', endActionId: 'speech-end-1' },
        actionIds: ['teach-1'],
      }),
      runtime.completeNode({
        nodeId: 'node:scene-1',
        idempotencyKey: 'complete:scene-1:1',
        speech: { startActionId: 'speech-start-1', endActionId: 'speech-end-1' },
        actionIds: ['teach-1'],
      }),
    ]);

    expect(first.duplicate).toBe(false);
    expect(retry.duplicate).toBe(true);
    expect(persisted.completedNodeIds).toEqual(['node:scene-1']);
    expect(publishEvent).toHaveBeenCalledTimes(1);
    expect(first.state).toBe('teaching');
  });

  it('maps a recovery node to its scene and fails loudly for stale history', () => {
    const plan = lessonPlanSchema.parse({
      schemaVersion: 1,
      id: 'lesson-plan:stage-1',
      courseId: 'course-1',
      stageId: 'stage-1',
      title: 'Lesson',
      version: 1,
      status: 'approved',
      createdAt: '2026-08-10T08:00:00.000Z',
      goals: [],
      nodes: [
        {
          id: 'node:scene-2',
          sceneId: 'scene-2',
          title: 'Scene 2',
          type: 'instruction',
          order: 0,
          goalIds: [],
        },
      ],
    });

    expect(resolveRecoverySceneId({ currentNodeId: null, lastSequence: -1 }, plan)).toBeNull();
    expect(resolveRecoverySceneId({ currentNodeId: 'node:scene-2', lastSequence: 0 }, plan)).toBe(
      'scene-2',
    );
    expect(() =>
      resolveRecoverySceneId({ currentNodeId: 'node:removed', lastSequence: 1 }, plan),
    ).toThrow('Cannot restore unknown lesson node "node:removed"');
  });

  it('aliases a generated scene nanoid onto an outline-keyed lesson node', () => {
    const generatedSceneId = 'BOZ_Eshc5ap3oACPP8B-R';
    const plan = lessonPlanSchema.parse({
      schemaVersion: 1,
      id: 'lesson-plan:stage-1',
      courseId: 'course-1',
      stageId: 'stage-1',
      title: 'Python 零基础入门',
      version: 1,
      status: 'approved',
      createdAt: '2026-08-10T08:00:00.000Z',
      goals: [],
      nodes: [
        {
          id: 'node:outline-intro',
          sceneId: 'outline-intro',
          title: '认识 Python',
          type: 'instruction',
          order: 0,
          goalIds: [],
        },
      ],
    });
    const scenes = [
      {
        id: generatedSceneId,
        outlineId: 'outline-intro',
        title: '认识 Python',
        type: 'slide' as const,
        order: 0,
        stageId: 'stage-1',
      },
    ];

    expect(
      resolveRecoverySceneId(
        { currentNodeId: `node:${generatedSceneId}`, lastSequence: 0 },
        plan,
        scenes,
      ),
    ).toBe(generatedSceneId);
    expect(
      resolveRecoverySceneId({ currentNodeId: 'node:outline-intro', lastSequence: 0 }, plan, scenes),
    ).toBe(generatedSceneId);
    expect(() =>
      resolveRecoverySceneId({ currentNodeId: 'node:removed', lastSequence: 1 }, plan, scenes),
    ).toThrow('Cannot restore unknown lesson node "node:removed"');
  });
});
