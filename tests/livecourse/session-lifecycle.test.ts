/**
 * A2 第二缝：会话生命周期命令边界。
 * 规格：docs/spec/04-detailed-design.md §1/§6、docs/spec/05-development-plan.md A2、
 * docs/spec/01-user-journeys.md J3.7 / J3.8 / J4.1–J4.4 六列契约。
 *
 * 覆盖：
 * - `saveAndLeaveSession`：严格「写 C → 销毁 W」顺序、幂等重试、各步失败留在课堂；
 * - `finalizeSession`：仅 `finalizing` 可调用、幂等归档 W→C（archived）、
 *   L 接缝在销毁 W 之前、失败保留 W 可重试、跨重启判重；
 * - `replaySession`：每次新建独立 replay W、范围严格取 C 已讲范围（完成课为
 *   全课）、暂停/继续/结束、加载失败不建 W、播放失败保留位置、永不写 C；
 * - `resolveCourseEntry`：首页同课选择态 / 课后选择态的入口投影。
 */
import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@livecourse/storage';
import { describe, expect, it, vi } from 'vitest';

import {
  lessonPlanSchema,
  teachingActionSchema,
  type LessonPlan,
  type TeachingAction,
} from '@/lib/livecourse/domain';
import {
  createTeachingActionRepository,
  livecourseActionSessionId,
  livecourseReplaySessionId,
  type TeachingActionSnapshot,
  type TeachingActionInspection,
  type TeachingActionRepository,
} from '@/lib/livecourse/session/action-repository';
import {
  ClassroomLifecycleError,
  ClassroomStateError,
  createClassroomController,
  createReplaySessionController,
  mergeTeachingActionsForArchive,
  type ClassroomCompletionDeps,
} from '@/lib/livecourse/session/controller';
import {
  courseStateSessionId,
  createCourseStateRepository,
  type CourseStateRepository,
} from '@/lib/livecourse/session/course-state-repository';
import {
  buildCourseStateSnapshot,
  resolveCourseEntry,
  type CourseStateSnapshot,
} from '@/lib/livecourse/session/course-state-snapshot';

import { resolveResumeNodeId } from '@/lib/livecourse/session/context';

import {
  COURSE_ID,
  LESSON_ONE,
  lessonOneClassroomHistory,
  makeCourseSnapshotInput,
} from './course-state-fixture';

const STAGE_ID = 'stage-1';
const LEARNER_ID = 'learner-1';
const NODE_A = 'node:lesson-1-a';
const NODE_B = 'node:lesson-1-b';
const NOW = '2026-08-17T04:00:00.000Z';

const CLASSROOM_SESSION_ID = livecourseActionSessionId({
  stageId: STAGE_ID,
  learnerId: LEARNER_ID,
  courseId: COURSE_ID,
  lessonId: LESSON_ONE,
});

function makeLessonPlan(nodes: LessonPlan['nodes']): LessonPlan {
  return lessonPlanSchema.parse({
    schemaVersion: 1,
    id: 'lesson-plan:stage-1',
    courseId: COURSE_ID,
    stageId: STAGE_ID,
    title: 'Lesson',
    version: 1,
    status: 'approved',
    createdAt: '2026-08-17T00:00:00.000Z',
    goals: [],
    nodes,
  });
}

const SINGLE_NODE_PLAN = makeLessonPlan([
  {
    id: NODE_A,
    sceneId: 'scene:lesson-1-a',
    title: 'A',
    type: 'instruction',
    order: 0,
    goalIds: [],
  },
]);

function action(overrides: Partial<TeachingAction>): TeachingAction {
  return teachingActionSchema.parse({
    schemaVersion: 1,
    id: 'action-x',
    courseId: COURSE_ID,
    lessonId: LESSON_ONE,
    nodeId: NODE_A,
    sequence: 0,
    timestamp: '2026-08-17T03:00:00.000Z',
    idempotencyKey: 'key-x',
    type: 'stage.highlight',
    payload: { sceneId: 'scene:lesson-1-a', elementId: 'el-1' },
    ...overrides,
  });
}

/** 追加一个完整教师回合：speech_start → 教学动作 → speech_end。 */
async function commitSpeechCycle(
  repository: TeachingActionRepository,
  nodeId: string,
  baseSequence: number,
): Promise<{ startActionId: string; actionId: string; endActionId: string }> {
  const ids = {
    startActionId: `speech-start:${nodeId}:${baseSequence}`,
    actionId: `teach:${nodeId}:${baseSequence}`,
    endActionId: `speech-end:${nodeId}:${baseSequence}`,
  };
  await repository.append(
    action({
      id: ids.startActionId,
      nodeId,
      sequence: baseSequence,
      idempotencyKey: `key:${ids.startActionId}`,
      type: 'avatar.speech_start',
      payload: { text: '开始。' },
    }),
  );
  await repository.append(
    action({
      id: ids.actionId,
      nodeId,
      sequence: baseSequence + 1,
      idempotencyKey: `key:${ids.actionId}`,
      type: 'stage.highlight',
      payload: { sceneId: `scene:${nodeId.slice(5)}`, elementId: 'el-1' },
    }),
  );
  await repository.append(
    action({
      id: ids.endActionId,
      nodeId,
      sequence: baseSequence + 2,
      idempotencyKey: `key:${ids.endActionId}`,
      type: 'avatar.speech_end',
      payload: {},
    }),
  );
  return ids;
}

interface Harness {
  store: BrowserRuntimeStore;
  actions: TeachingActionRepository;
  courseState: CourseStateRepository;
  order: string[];
  makeController: (options?: {
    completion?: ClassroomCompletionDeps;
    failSaveOnce?: boolean;
    failDestroy?: { current: boolean };
    finalizeLearnerMemory?: () => Promise<void>;
  }) => ReturnType<typeof createClassroomController>;
}

function harness(): Harness {
  const store = new BrowserRuntimeStore({ dbName: `session-lifecycle-${crypto.randomUUID()}` });
  const actions = createTeachingActionRepository({
    store,
    stageId: STAGE_ID,
    learnerId: LEARNER_ID,
    courseId: COURSE_ID,
    lessonId: LESSON_ONE,
  });
  const courseState = createCourseStateRepository({
    store,
    stageId: STAGE_ID,
    learnerId: LEARNER_ID,
    courseId: COURSE_ID,
  });
  const order: string[] = [];

  const makeController: Harness['makeController'] = (options = {}) => {
    const lifecycleCourseState = {
      load: () => courseState.load(),
      loadVersioned: () => courseState.loadVersioned(),
      save: async (
        input: Parameters<CourseStateRepository['save']>[0],
        saveOptions?: { expectedRevision?: number | null },
      ) => {
        if (options.failSaveOnce) {
          options.failSaveOnce = false;
          throw new Error('injected C write failure');
        }
        order.push('saveC');
        return courseState.save(input, saveOptions);
      },
    };
    return createClassroomController({
      repository: actions,
      applyPresentation: () => ({ success: true as const }),
      publish: () => undefined,
      completion: options.completion,
      lifecycle: {
        classroomSessionId: CLASSROOM_SESSION_ID,
        courseState: lifecycleCourseState,
        destroyWorkSession: async () => {
          if (options.failDestroy?.current) {
            options.failDestroy.current = false;
            throw new Error('injected W destroy failure');
          }
          order.push('destroyW');
          await actions.destroy();
        },
        ...(options.finalizeLearnerMemory
          ? {
              finalizeLearnerMemory: async () => {
                order.push('writeL');
                await options.finalizeLearnerMemory!();
              },
            }
          : {}),
      },
    });
  };

  return { store, actions, courseState, order, makeController };
}

/** 以当前 W 动作播种初始 C（模拟「开始生成写 C」接缝），返回 revision。 */
async function seedCourseState(h: Harness, idempotencyKey = 'seed-c'): Promise<number> {
  const teachingActions = await h.actions.load();
  await h.courseState.save(makeCourseSnapshotInput({ idempotencyKey, teachingActions }));
  return (await h.courseState.loadVersioned())!.revision;
}

async function cRecordCount(store: BrowserRuntimeStore): Promise<number> {
  const session = await store.getSession(
    courseStateSessionId({
      stageId: STAGE_ID,
      learnerId: LEARNER_ID,
      courseId: COURSE_ID,
    }),
  );
  if (!session) return 0;
  return (await store.listRecords(session.id)).length;
}

async function wExists(store: BrowserRuntimeStore): Promise<boolean> {
  return (await store.getSession(CLASSROOM_SESSION_ID)) !== undefined;
}

function completionDeps(lessonPlan: LessonPlan): ClassroomCompletionDeps {
  return {
    classroomSessionId: CLASSROOM_SESSION_ID,
    courseId: COURSE_ID,
    lessonId: LESSON_ONE,
    lessonPlan,
    progressStore: undefined as unknown as ClassroomCompletionDeps['progressStore'],
    hasValidEvidence: () => false,
    now: () => NOW,
  };
}

describe('mergeTeachingActionsForArchive（归档合并，A2）', () => {
  it('appends work actions after the persisted history with resequenced order', () => {
    const persisted = {
      actions: [action({ id: 'a0', sequence: 0 }), action({ id: 'a1', sequence: 1 })],
      currentNodeId: NODE_A,
      lastSequence: 1,
    };
    const work = {
      actions: [action({ id: 'b0', nodeId: NODE_B, sequence: 0 })],
      currentNodeId: NODE_B,
      lastSequence: 0,
    };
    const merged = mergeTeachingActionsForArchive(persisted, work);
    expect(merged.actions.map((item) => [item.id, item.sequence])).toEqual([
      ['a0', 0],
      ['a1', 1],
      ['b0', 2],
    ]);
    expect(merged.currentNodeId).toBe(NODE_B);
    expect(merged.lastSequence).toBe(2);
  });

  it('keeps the persisted history when the work actions are already archived', () => {
    const persisted = {
      actions: [action({ id: 'a0', sequence: 0 })],
      currentNodeId: NODE_A,
      lastSequence: 0,
    };
    const work = {
      actions: [action({ id: 'a0', sequence: 0 })],
      currentNodeId: NODE_A,
      lastSequence: 0,
    };
    const merged = mergeTeachingActionsForArchive(persisted, work);
    expect(merged.actions).toHaveLength(1);
    expect(merged.lastSequence).toBe(0);
  });

  it('is deterministic — the same inputs always produce the same snapshot content', () => {
    const persisted = {
      actions: [action({ id: 'a0', sequence: 0 })],
      currentNodeId: NODE_A,
      lastSequence: 0,
    };
    const work = {
      actions: [action({ id: 'b0', nodeId: NODE_B, sequence: 0 })],
      currentNodeId: NODE_B,
      lastSequence: 0,
    };
    expect(mergeTeachingActionsForArchive(persisted, work)).toEqual(
      mergeTeachingActionsForArchive(persisted, work),
    );
  });
});

describe('saveAndLeaveSession（J3.7 暂时离开课堂，A2）', () => {
  it('persists the C recovery point first, then destroys W — in that strict order', async () => {
    const h = harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);
    await seedCourseState(h);

    const controller = h.makeController();
    await controller.load();
    const result = await controller.saveAndLeaveSession();

    expect(h.order).toEqual(['saveC', 'destroyW']);
    expect(result.duplicate).toBe(false);
    expect(result.workSessionDestroyed).toBe(true);
    expect(result.snapshot.teachingActions.actions).toHaveLength(3);
    expect(result.snapshot.teachingActions.currentNodeId).toBe(NODE_A);
    expect(result.snapshot.lifecycle?.status ?? 'in_progress').toBe('in_progress');
    expect(await wExists(h.store)).toBe(false);
  });

  it('is idempotent: a retry after full success returns the first result and never rewrites C', async () => {
    const h = harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);
    await seedCourseState(h);
    const before = await cRecordCount(h.store);

    const controller = h.makeController();
    await controller.load();
    const first = await controller.saveAndLeaveSession();
    const second = await controller.saveAndLeaveSession();

    expect(second.duplicate).toBe(true);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(second.snapshot.id).toBe(first.snapshot.id);
    expect(await cRecordCount(h.store)).toBe(before + 1);
  });

  it('keeps the learner in the classroom with W intact when the C write fails', async () => {
    const h = harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);
    await seedCourseState(h);

    const controller = h.makeController({ failSaveOnce: true });
    await controller.load();
    await expect(controller.saveAndLeaveSession()).rejects.toThrow('injected C write failure');

    // 失败留在课堂：状态不变，W 完整保留，可重试。
    expect(controller.getState()).toBe('teaching');
    expect((await h.actions.load()).actions).toHaveLength(3);
    expect(await wExists(h.store)).toBe(true);

    const result = await controller.saveAndLeaveSession();
    expect(result.workSessionDestroyed).toBe(true);
    expect(await wExists(h.store)).toBe(false);
  });

  it('treats W-destroy failure as overall failure; the retry skips the C rewrite', async () => {
    const h = harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);
    await seedCourseState(h);
    const before = await cRecordCount(h.store);

    const controller = h.makeController({ failDestroy: { current: true } });
    await controller.load();
    await expect(controller.saveAndLeaveSession()).rejects.toThrow('injected W destroy failure');
    expect(await wExists(h.store)).toBe(true);

    const result = await controller.saveAndLeaveSession();
    expect(result.duplicate).toBe(true);
    expect(await cRecordCount(h.store)).toBe(before + 1);
    expect(await wExists(h.store)).toBe(false);
  });

  it('recognizes an already-destroyed W by the C tail and reports a duplicate leave', async () => {
    const h = harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);
    await seedCourseState(h);

    const first = h.makeController();
    await first.load();
    const left = await first.saveAndLeaveSession();
    const records = await cRecordCount(h.store);

    // 协调器重启后再次离开：W 已空，C tail 是上次离开的保存点。
    const second = h.makeController();
    await second.load();
    const result = await second.saveAndLeaveSession();
    expect(result.duplicate).toBe(true);
    expect(result.idempotencyKey).toBe(left.idempotencyKey);
    expect(await cRecordCount(h.store)).toBe(records);
  });

  it('fails loud and keeps W when no course state snapshot exists yet', async () => {
    const h = harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);

    const controller = h.makeController();
    await controller.load();
    await expect(controller.saveAndLeaveSession()).rejects.toThrow(ClassroomLifecycleError);
    expect(await wExists(h.store)).toBe(true);
  });

  it('refuses to run outside teaching/checking/paused/interrupted', async () => {
    const h = harness();
    const controller = h.makeController();
    // loading 态无权离开。
    await expect(controller.saveAndLeaveSession()).rejects.toThrow(ClassroomStateError);
  });

  it('merges the current W onto the persisted history across classroom sessions', async () => {
    const h = harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);
    await seedCourseState(h);

    const first = h.makeController();
    await first.load();
    await first.saveAndLeaveSession();

    // 下次「继续」：新建 teaching W（同会话 id 重建，sequence 从 0 开始）。
    await commitSpeechCycle(h.actions, NODE_B, 0);
    const second = h.makeController();
    await second.load();
    const result = await second.saveAndLeaveSession();

    expect(result.snapshot.teachingActions.actions.map((item) => item.sequence)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(result.snapshot.teachingActions.currentNodeId).toBe(NODE_B);
    expect(result.snapshot.teachingActions.lastSequence).toBe(5);
  });
});

describe('finalizeSession（J3.8 完成归档，A2）', () => {
  async function driveToFinalizing(
    h: Harness,
    options: Parameters<Harness['makeController']>[0] = {},
  ) {
    const completion = completionDeps(SINGLE_NODE_PLAN);
    completion.progressStore = h.courseState;
    const controller = h.makeController({ ...options, completion });
    const cycle = await commitSpeechCycle(h.actions, NODE_A, 0);
    await seedCourseState(h);
    await controller.load();
    const completion_result = await controller.completeNode({
      nodeId: NODE_A,
      idempotencyKey: `complete:${NODE_A}`,
      speech: { startActionId: cycle.startActionId, endActionId: cycle.endActionId },
      actionIds: [cycle.actionId],
    });
    expect(completion_result.state).toBe('finalizing');
    return controller;
  }

  it('rejects finalization outside the finalizing state', async () => {
    const h = harness();
    await seedCourseState(h);
    const controller = h.makeController();
    await controller.load();
    await expect(controller.finalizeSession()).rejects.toThrow(ClassroomStateError);
  });

  it('archives W → C with lifecycle=archived, then runs the L seam, then destroys W', async () => {
    const h = harness();
    const writeL = vi.fn(async () => {});
    const controller = await driveToFinalizing(h, { finalizeLearnerMemory: writeL });

    const result = await controller.finalizeSession();

    // 严格顺序：归档 C → L 接缝 → 销毁 W。
    expect(h.order.filter((step) => step !== 'saveC' || true)).toEqual(
      expect.arrayContaining(['saveC', 'writeL', 'destroyW']),
    );
    expect(h.order.indexOf('saveC')).toBeLessThan(h.order.indexOf('writeL'));
    expect(h.order.indexOf('writeL')).toBeLessThan(h.order.indexOf('destroyW'));
    expect(result.snapshot.lifecycle?.status).toBe('archived');
    expect(result.snapshot.progress?.completedNodeIds).toContain(NODE_A);
    expect(result.workSessionDestroyed).toBe(true);
    expect(await wExists(h.store)).toBe(false);
  });

  it('fails in finalizing with W kept when the L seam throws; retry does not rewrite C', async () => {
    const h = harness();
    let failing = true;
    const controller = await driveToFinalizing(h, {
      finalizeLearnerMemory: async () => {
        if (failing) throw new Error('injected L write failure');
      },
    });
    const before = await cRecordCount(h.store);

    await expect(controller.finalizeSession()).rejects.toThrow('injected L write failure');
    expect(controller.getState()).toBe('finalizing');
    expect(await wExists(h.store)).toBe(true);

    failing = false;
    const result = await controller.finalizeSession();
    expect(result.duplicate).toBe(true);
    expect(await cRecordCount(h.store)).toBe(before + 1);
    expect(await wExists(h.store)).toBe(false);
  });

  it('is idempotent across coordinator restarts: an archived C tail is recognized without state', async () => {
    const h = harness();
    const first = await driveToFinalizing(h);
    const done = await first.finalizeSession();
    const records = await cRecordCount(h.store);

    // 新协调器实例（状态 loading）：不得再次 finalization，判重返回。
    const second = h.makeController();
    const result = await second.finalizeSession();
    expect(result.duplicate).toBe(true);
    expect(result.snapshot.id).toBe(done.snapshot.id);
    expect(result.snapshot.lifecycle?.status).toBe('archived');
    expect(await cRecordCount(h.store)).toBe(records);
  });

  it('keeps W and stays finalizing when the archive write itself fails; retry succeeds', async () => {
    const h = harness();
    const controller = await driveToFinalizing(h, { failSaveOnce: true });
    const before = await cRecordCount(h.store);

    await expect(controller.finalizeSession()).rejects.toThrow('injected C write failure');
    expect(controller.getState()).toBe('finalizing');
    expect(await wExists(h.store)).toBe(true);
    // 归档写入失败不得改变 C。
    expect(await cRecordCount(h.store)).toBe(before);
    const latest = await h.courseState.loadVersioned();
    expect(latest!.snapshot.lifecycle?.status ?? 'in_progress').toBe('in_progress');

    const result = await controller.finalizeSession();
    expect(result.duplicate).toBe(false);
    expect(result.snapshot.lifecycle?.status).toBe('archived');
    expect(await wExists(h.store)).toBe(false);
  });

  it('fails loud when C is already archived by an unknown writer', async () => {
    const h = harness();
    await seedCourseState(h);
    const versioned = await h.courseState.loadVersioned();
    await h.courseState.save(
      {
        ...makeCourseSnapshotInput({ idempotencyKey: 'finalize:someone-else' }),
        teachingActions: versioned!.snapshot.teachingActions,
        lifecycle: { status: 'archived', updatedAt: NOW },
      },
      { expectedRevision: versioned!.revision },
    );

    // 让 W 真实存在（含未归档动作），验证 fail loud 不会销毁它。
    await commitSpeechCycle(h.actions, NODE_A, 0);
    const before = await cRecordCount(h.store);
    const controller = h.makeController();
    await expect(controller.finalizeSession()).rejects.toThrow(
      /already archived by an unknown writer/,
    );
    await expect(controller.finalizeSession()).rejects.toThrow(ClassroomLifecycleError);
    // 拒绝归档：不销毁 W、不改写 C。
    expect(await wExists(h.store)).toBe(true);
    expect(await cRecordCount(h.store)).toBe(before);
    expect((await h.courseState.loadVersioned())!.snapshot.idempotencyKey).toBe(
      'finalize:someone-else',
    );
  });
});

describe('replaySession（J4.2 / J4.4 再听，A2）', () => {
  function replayHarness(options: { failLoad?: boolean } = {}) {
    const h = harness();
    const replayId = `replay-${crypto.randomUUID()}`;
    const replayRepository = createTeachingActionRepository({
      store: h.store,
      stageId: STAGE_ID,
      learnerId: LEARNER_ID,
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
      replayId,
    });
    const applied: TeachingAction[] = [];
    const replay = createReplaySessionController({
      repository: replayRepository,
      loadCourseState: async () => {
        if (options.failLoad) throw new Error('injected C load failure');
        return h.courseState.load();
      },
      applyPresentation: (replayAction) => {
        applied.push(replayAction);
        return { success: true as const };
      },
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
      now: () => NOW,
    });
    return { ...h, replay, replayId, applied };
  }

  async function seedProgress(h: Harness, completedNodeIds: string[]): Promise<void> {
    await seedCourseState(h);
    if (completedNodeIds.length > 0) {
      await h.courseState.saveProgress({
        idempotencyKey: 'seed-progress',
        progress: {
          completedNodeIds,
          lastCompletedNodeId: completedNodeIds.at(-1)!,
          updatedAt: NOW,
        },
      });
    }
  }

  function replayWithRepository(
    h: Harness,
    repository: TeachingActionRepository,
    applied: TeachingAction[],
    rollback: () => void,
  ) {
    return createReplaySessionController({
      repository,
      loadCourseState: () => h.courseState.load(),
      applyPresentation: (replayAction) => {
        applied.push(replayAction);
        return { success: true as const, rollback };
      },
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
      now: () => NOW,
    });
  }

  function appendFailureRepository(options: {
    appendError: Error;
    inspect: (
      action: TeachingAction,
    ) => TeachingActionInspection | Promise<TeachingActionInspection>;
    commitBeforeThrow?: boolean;
  }): {
    repository: TeachingActionRepository;
    getAppendCalls: () => number;
    getInspectCalls: () => number;
  } {
    let appendCalls = 0;
    let inspectCalls = 0;
    let snapshot = {
      actions: [] as TeachingAction[],
      currentNodeId: null as string | null,
      lastSequence: -1,
    };
    const repository: TeachingActionRepository = {
      load: async () => snapshot,
      inspect: async (candidate) => {
        inspectCalls += 1;
        return options.inspect(candidate);
      },
      append: async (candidate) => {
        appendCalls += 1;
        if (options.commitBeforeThrow) {
          snapshot = {
            actions: [candidate],
            currentNodeId: candidate.nodeId,
            lastSequence: 0,
          };
        }
        throw options.appendError;
      },
      destroy: async () => {},
    };
    return {
      repository,
      getAppendCalls: () => appendCalls,
      getInspectCalls: () => inspectCalls,
    };
  }

  it('uses a distinct replay W session id for every replay', () => {
    const first = livecourseReplaySessionId({
      stageId: STAGE_ID,
      learnerId: LEARNER_ID,
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
      replayId: 'r1',
    });
    const second = livecourseReplaySessionId({
      stageId: STAGE_ID,
      learnerId: LEARNER_ID,
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
      replayId: 'r2',
    });
    expect(first).not.toBe(CLASSROOM_SESSION_ID);
    expect(first).not.toBe(second);
  });

  it('starts with the persisted taught range from C and a fresh replay W', async () => {
    const r = replayHarness();
    await seedProgress(r, [NODE_A]);
    const started = await r.replay.start();

    expect(started.range).toEqual([NODE_A]);
    expect(started.position).toBe(NODE_A);
    expect(started.resumed).toBe(false);
    expect(r.replay.getState()).toBe('playing');
    // replay 动作提交进了 replay W，且呈现先于提交。
    expect(r.applied).toHaveLength(1);
    expect((await r.replay.getPosition())!).toBe(NODE_A);
  });

  it('takes the full lesson as the range for an archived (completed) course', async () => {
    const r = replayHarness();
    await seedProgress(r, [NODE_A]);
    const versioned = await r.courseState.loadVersioned();
    await r.courseState.save(
      {
        ...makeCourseSnapshotInput({ idempotencyKey: 'finalize:manual' }),
        teachingActions: versioned!.snapshot.teachingActions,
        progress: versioned!.snapshot.progress,
        lifecycle: { status: 'archived', updatedAt: NOW },
      },
      { expectedRevision: versioned!.revision },
    );

    const started = await r.replay.start();
    expect(started.range).toEqual([NODE_A, NODE_B]);
  });

  it('stays at the entry choice state when C loading fails — no replay W is created', async () => {
    const r = replayHarness({ failLoad: true });
    await expect(r.replay.start()).rejects.toThrow('injected C load failure');
    expect(r.replay.getState()).toBe('loading');
    const sessionId = livecourseReplaySessionId({
      stageId: STAGE_ID,
      learnerId: LEARNER_ID,
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
      replayId: r.replayId,
    });
    expect(await r.store.getSession(sessionId)).toBeUndefined();
  });

  it('refuses to start when the course has no persisted taught range', async () => {
    const r = replayHarness();
    await seedProgress(r, []);
    await expect(r.replay.start()).rejects.toThrow(ClassroomLifecycleError);
    expect(r.replay.getState()).toBe('loading');
  });

  it('pauses and resumes by writing only the replay W', async () => {
    const r = replayHarness();
    await seedProgress(r, [NODE_A, NODE_B]);
    await r.replay.start();
    const cRecords = await cRecordCount(r.store);

    expect(await r.replay.pause()).toBe('paused');
    expect(await r.replay.resume()).toBe('playing');
    // 暂停 / 继续只写 replay W，不写 C。
    expect(await cRecordCount(r.store)).toBe(cRecords);
    await expect(r.replay.resume()).rejects.toThrow(ClassroomStateError);
  });

  it('keeps the replay position on playback failure and retries from it', async () => {
    const r = replayHarness();
    await seedProgress(r, [NODE_A, NODE_B]);
    await r.replay.start();
    await r.replay.advance();
    expect(await r.replay.getPosition()).toBe(NODE_B);

    expect(await r.replay.notifyPlaybackFailure()).toBe('failed');
    // 播放失败保留当前回放位置。
    expect(await r.replay.getPosition()).toBe(NODE_B);

    expect(await r.replay.retry()).toBe('playing');
    expect(await r.replay.getPosition()).toBe(NODE_B);
  });

  it('reconciles an append throw as a durable duplicate without rolling back presentation', async () => {
    const h = harness();
    await seedProgress(h, [NODE_A]);
    const applied: TeachingAction[] = [];
    const rollback = vi.fn();
    const appendError = new Error('append response lost after commit');
    const failure = appendFailureRepository({
      appendError,
      commitBeforeThrow: true,
      inspect: async (candidate) => ({
        status: 'duplicate' as const,
        action: candidate,
        snapshot: {
          actions: [candidate],
          currentNodeId: candidate.nodeId,
          lastSequence: 0,
        },
      }),
    });
    const replay = replayWithRepository(h, failure.repository, applied, rollback);

    await expect(replay.start()).resolves.toMatchObject({
      state: 'playing',
      position: NODE_A,
      resumed: false,
    });
    expect(replay.getState()).toBe('playing');
    expect(await replay.getPosition()).toBe(NODE_A);
    expect(applied).toHaveLength(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(failure.getAppendCalls()).toBe(1);
    expect(failure.getInspectCalls()).toBe(1);
  });

  it('rolls back presentation when append throw is reconciled as a new action', async () => {
    const h = harness();
    await seedProgress(h, [NODE_A]);
    const applied: TeachingAction[] = [];
    const rollback = vi.fn();
    const appendError = new Error('append rejected');
    const failure = appendFailureRepository({
      appendError,
      inspect: async (candidate) => ({
        status: 'new' as const,
        action: candidate,
        snapshot: { actions: [], currentNodeId: null, lastSequence: -1 },
      }),
    });
    const replay = replayWithRepository(h, failure.repository, applied, rollback);

    await expect(replay.start()).rejects.toBe(appendError);
    expect(replay.getState()).toBe('loading');
    expect(await replay.getPosition()).toBeNull();
    expect(applied).toHaveLength(1);
    expect(rollback).toHaveBeenCalledOnce();
    expect(failure.getAppendCalls()).toBe(1);
    expect(failure.getInspectCalls()).toBe(1);
  });

  it('surfaces append uncertainty when reconciliation inspect fails without rolling back', async () => {
    const h = harness();
    await seedProgress(h, [NODE_A]);
    const applied: TeachingAction[] = [];
    const rollback = vi.fn();
    const appendError = new Error('append response lost');
    const inspectError = new Error('inspect unavailable');
    const failure = appendFailureRepository({
      appendError,
      inspect: async () => {
        throw inspectError;
      },
    });
    const replay = replayWithRepository(h, failure.repository, applied, rollback);

    await expect(replay.start()).rejects.toMatchObject({
      name: 'ReplayAppendUncertaintyError',
      operationCause: appendError,
      reconciliationCause: inspectError,
    });
    expect(replay.getState()).toBe('loading');
    expect(await replay.getPosition()).toBeNull();
    expect(applied).toHaveLength(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(failure.getAppendCalls()).toBe(1);
    expect(failure.getInspectCalls()).toBe(1);
  });

  it('reconciles an uncertain start with the original action key instead of minting a replacement', async () => {
    const h = harness();
    await seedProgress(h, [NODE_A]);
    let appendCalls = 0;
    let inspectCalls = 0;
    let snapshot: TeachingActionSnapshot = {
      actions: [],
      currentNodeId: null,
      lastSequence: -1,
    };
    const appendCandidates: TeachingAction[] = [];
    const repository: TeachingActionRepository = {
      load: async () => snapshot,
      inspect: async (candidate) => {
        inspectCalls += 1;
        if (inspectCalls === 1) throw new Error('inspect temporarily unavailable');
        return { status: 'new' as const, action: candidate, snapshot };
      },
      append: async (candidate) => {
        appendCalls += 1;
        appendCandidates.push(candidate);
        if (appendCalls === 1) throw new Error('append response lost');
        if (candidate.type !== 'lesson.goto_node') throw new Error('expected goto action');
        snapshot = {
          actions: [candidate],
          currentNodeId: candidate.payload.targetNodeId,
          lastSequence: candidate.sequence,
        };
        return {
          action: candidate,
          duplicate: false,
          recoveryPoint: {
            currentNodeId: snapshot.currentNodeId,
            lastSequence: snapshot.lastSequence,
          },
        };
      },
      destroy: async () => {},
    };
    const applied: TeachingAction[] = [];
    const rollback = vi.fn();
    const commit = vi.fn();
    const replay = createReplaySessionController({
      repository,
      loadCourseState: () => h.courseState.load(),
      applyPresentation: (candidate) => {
        applied.push(candidate);
        return { success: true as const, rollback, commit };
      },
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
      now: () => NOW,
      createActionId: (() => {
        let count = 0;
        return () => `replay-uncertain-${++count}`;
      })(),
    });

    await expect(replay.start()).rejects.toMatchObject({
      name: 'ReplayAppendUncertaintyError',
    });
    await expect(replay.start()).resolves.toMatchObject({
      state: 'playing',
      position: NODE_A,
      resumed: false,
    });

    expect(appendCalls).toBe(2);
    expect(inspectCalls).toBe(2);
    expect(appendCandidates).toHaveLength(2);
    expect(appendCandidates[1]).toMatchObject({
      id: appendCandidates[0]!.id,
      sequence: appendCandidates[0]!.sequence,
      idempotencyKey: appendCandidates[0]!.idempotencyKey,
    });
    expect(applied).toHaveLength(2);
    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
  });

  it('settles a late durable uncertain start without reapplying its presentation', async () => {
    const h = harness();
    await seedProgress(h, [NODE_A]);
    let appendCalls = 0;
    let inspectCalls = 0;
    let durableAction: TeachingAction | null = null;
    const repository: TeachingActionRepository = {
      load: async () => ({
        actions: durableAction ? [durableAction] : [],
        currentNodeId:
          durableAction?.type === 'lesson.goto_node' ? durableAction.payload.targetNodeId : null,
        lastSequence: durableAction?.sequence ?? -1,
      }),
      inspect: async (candidate) => {
        inspectCalls += 1;
        if (inspectCalls === 1) throw new Error('inspect temporarily unavailable');
        return {
          status: 'duplicate' as const,
          action: durableAction ?? candidate,
          snapshot: {
            actions: [durableAction ?? candidate],
            currentNodeId: (() => {
              const action = durableAction ?? candidate;
              return action.type === 'lesson.goto_node' ? action.payload.targetNodeId : null;
            })(),
            lastSequence: (durableAction ?? candidate).sequence,
          },
        };
      },
      append: async (candidate) => {
        appendCalls += 1;
        durableAction = candidate;
        throw new Error('append response lost after commit');
      },
      destroy: async () => {},
    };
    const applied: TeachingAction[] = [];
    const commit = vi.fn();
    const replay = createReplaySessionController({
      repository,
      loadCourseState: () => h.courseState.load(),
      applyPresentation: (candidate) => {
        applied.push(candidate);
        return { success: true as const, commit };
      },
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
      now: () => NOW,
    });

    await expect(replay.start()).rejects.toMatchObject({
      name: 'ReplayAppendUncertaintyError',
    });
    await expect(replay.start()).resolves.toMatchObject({
      state: 'playing',
      position: NODE_A,
      resumed: false,
    });
    expect(appendCalls).toBe(1);
    expect(inspectCalls).toBe(2);
    expect(applied).toHaveLength(1);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('retries a durable replay presentation commit without appending or applying again', async () => {
    const h = harness();
    await seedProgress(h, [NODE_A]);
    const repository = createTeachingActionRepository({
      store: h.store,
      stageId: STAGE_ID,
      learnerId: LEARNER_ID,
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
      replayId: `replay-commit-${crypto.randomUUID()}`,
    });
    const applied: TeachingAction[] = [];
    let commitCalls = 0;
    const replay = createReplaySessionController({
      repository,
      loadCourseState: () => h.courseState.load(),
      applyPresentation: (candidate) => {
        applied.push(candidate);
        return {
          success: true as const,
          commit: () => {
            commitCalls += 1;
            if (commitCalls === 1) throw new Error('commit unavailable');
          },
        };
      },
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
      now: () => NOW,
    });

    await expect(replay.start()).rejects.toMatchObject({
      name: 'ClassroomPresentationCommitError',
    });
    expect(replay.getState()).toBe('loading');
    await expect(replay.start()).resolves.toMatchObject({
      state: 'playing',
      position: NODE_A,
      resumed: false,
    });
    expect(applied).toHaveLength(1);
    expect(commitCalls).toBe(2);
  });

  it('uses the retained navigation action when retrying after an uncertain advance', async () => {
    const h = harness();
    await seedProgress(h, [NODE_A, NODE_B]);
    let appendCalls = 0;
    let inspectCalls = 0;
    let snapshot: TeachingActionSnapshot = {
      actions: [],
      currentNodeId: null,
      lastSequence: -1,
    };
    const candidates: TeachingAction[] = [];
    const repository: TeachingActionRepository = {
      load: async () => snapshot,
      inspect: async (candidate) => {
        inspectCalls += 1;
        if (inspectCalls === 1) throw new Error('inspect unavailable');
        return { status: 'new' as const, action: candidate, snapshot };
      },
      append: async (candidate) => {
        appendCalls += 1;
        candidates.push(candidate);
        if (appendCalls === 2) throw new Error('advance response lost');
        if (candidate.type !== 'lesson.goto_node') throw new Error('expected goto action');
        snapshot = {
          actions: [...snapshot.actions, candidate],
          currentNodeId: candidate.payload.targetNodeId,
          lastSequence: candidate.sequence,
        };
        return {
          action: candidate,
          duplicate: false,
          recoveryPoint: {
            currentNodeId: snapshot.currentNodeId,
            lastSequence: snapshot.lastSequence,
          },
        };
      },
      destroy: async () => {},
    };
    const applied: TeachingAction[] = [];
    const rollback = vi.fn();
    const replay = createReplaySessionController({
      repository,
      loadCourseState: () => h.courseState.load(),
      applyPresentation: (candidate) => {
        applied.push(candidate);
        return { success: true as const, rollback };
      },
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
      now: () => NOW,
    });

    await replay.start();
    await expect(replay.advanceResult()).resolves.toMatchObject({ status: 'failed' });
    await replay.notifyPlaybackFailure();
    await expect(replay.retry()).resolves.toBe('playing');

    expect(appendCalls).toBe(3);
    expect(inspectCalls).toBe(2);
    expect(candidates[2]).toMatchObject({
      id: candidates[1]!.id,
      sequence: candidates[1]!.sequence,
      idempotencyKey: candidates[1]!.idempotencyKey,
      payload: candidates[1]!.payload,
    });
    expect(applied).toHaveLength(3);
    expect(rollback).toHaveBeenCalledOnce();
    expect(await replay.getPosition()).toBe(NODE_B);
  });

  it('advances strictly inside the taught range', async () => {
    const r = replayHarness();
    await seedProgress(r, [NODE_A]);
    await r.replay.start();
    // 范围只有一个节点：advance 没有下一节点。
    expect(await r.replay.advance()).toBeNull();
    expect(await r.replay.getPosition()).toBe(NODE_A);
  });

  it('returns structured replay advance outcomes without hiding failures', async () => {
    const r = replayHarness();
    await seedProgress(r, [NODE_A, NODE_B]);
    await r.replay.start();
    await expect(r.replay.advanceResult('node:stale')).resolves.toEqual({
      status: 'position-mismatch',
      expectedNodeId: 'node:stale',
      actualNodeId: NODE_A,
    });
    await expect(r.replay.advanceResult()).resolves.toEqual({
      status: 'advanced',
      nodeId: NODE_B,
    });
    await expect(r.replay.advanceResult()).resolves.toEqual({
      status: 'at-end',
      position: NODE_B,
    });
  });

  it('navigates only to a different node inside the taught range', async () => {
    const r = replayHarness();
    await seedProgress(r, [NODE_A, NODE_B]);
    await r.replay.start();
    await expect(r.replay.navigate('node:outside')).rejects.toThrow(ClassroomLifecycleError);
    await expect(r.replay.navigate(NODE_A)).resolves.toEqual({ advanced: false, ended: false });
    await expect(r.replay.navigate(NODE_B)).resolves.toEqual({ advanced: true, ended: false });
    expect(await r.replay.getPosition()).toBe(NODE_B);
  });

  it('destroys only the replay W on end, idempotently, and never touches C', async () => {
    const r = replayHarness();
    await seedProgress(r, [NODE_A]);
    await r.replay.start();
    const cRecords = await cRecordCount(r.store);
    const replaySessionId = livecourseReplaySessionId({
      stageId: STAGE_ID,
      learnerId: LEARNER_ID,
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
      replayId: r.replayId,
    });
    expect(await r.store.getSession(replaySessionId)).toBeDefined();

    expect(await r.replay.end()).toBe('ended');
    expect(await r.store.getSession(replaySessionId)).toBeUndefined();
    // 幂等：再次结束直接返回。
    expect(await r.replay.end()).toBe('ended');
    // replay 全程未写 C。
    expect(await cRecordCount(r.store)).toBe(cRecords);
    // 原课堂 W / 其他会话不受影响——本测试未创建 teaching W，无从销毁。
  });

  it('resumes from the retained replay W position after a playback failure restart', async () => {
    const store = new BrowserRuntimeStore({ dbName: `replay-resume-${crypto.randomUUID()}` });
    const courseState = createCourseStateRepository({
      store,
      stageId: STAGE_ID,
      learnerId: LEARNER_ID,
      courseId: COURSE_ID,
    });
    const h = harness();
    void h;
    const teachingActions = { actions: [], currentNodeId: null, lastSequence: -1 };
    await courseState.save(makeCourseSnapshotInput({ idempotencyKey: 'seed-c', teachingActions }));
    await courseState.saveProgress({
      idempotencyKey: 'seed-progress',
      progress: { completedNodeIds: [NODE_A, NODE_B], lastCompletedNodeId: NODE_B, updatedAt: NOW },
    });

    const replayId = 'replay-fixed';
    const make = () =>
      createReplaySessionController({
        repository: createTeachingActionRepository({
          store,
          stageId: STAGE_ID,
          learnerId: LEARNER_ID,
          courseId: COURSE_ID,
          lessonId: LESSON_ONE,
          replayId,
        }),
        loadCourseState: () => courseState.load(),
        applyPresentation: () => ({ success: true as const }),
        courseId: COURSE_ID,
        lessonId: LESSON_ONE,
        now: () => NOW,
      });

    const first = make();
    await first.start();
    await first.advance();
    await first.notifyPlaybackFailure();

    // 同 replayId 的重开（播放失败重试语义）：从保留位置继续。
    const second = make();
    const started = await second.start();
    expect(started.resumed).toBe(true);
    expect(started.position).toBe(NODE_B);
  });

  it('retries a retained-position presentation commit without appending another W action', async () => {
    const h = harness();
    await seedProgress(h, [NODE_A, NODE_B]);
    const replayId = `replay-present-commit-${crypto.randomUUID()}`;
    const repository = createTeachingActionRepository({
      store: h.store,
      stageId: STAGE_ID,
      learnerId: LEARNER_ID,
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
      replayId,
    });
    const applied: TeachingAction[] = [];
    let commitCalls = 0;
    let retainedCommitAttempts = 0;
    const replay = createReplaySessionController({
      repository,
      loadCourseState: () => h.courseState.load(),
      applyPresentation: (candidate) => {
        applied.push(candidate);
        return {
          success: true as const,
          commit: () => {
            commitCalls += 1;
            if (candidate.id.startsWith('replay-present:') && ++retainedCommitAttempts === 1) {
              throw new Error('retained-position commit unavailable');
            }
          },
        };
      },
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
      now: () => NOW,
    });

    await replay.start();
    await replay.advance();
    await replay.notifyPlaybackFailure();
    await expect(replay.start()).rejects.toMatchObject({
      name: 'ClassroomPresentationCommitError',
    });
    expect(replay.getState()).toBe('failed');
    await expect(replay.start()).resolves.toMatchObject({
      state: 'playing',
      position: NODE_B,
      resumed: true,
    });

    const snapshot = await repository.load();
    expect(snapshot.actions).toHaveLength(2);
    expect(applied).toHaveLength(3);
    expect(commitCalls).toBe(4);
  });
});

describe('resolveResumeNodeId（J4.4「继续」恢复目标，A2）', () => {
  const emptyWork = { actions: [], currentNodeId: null, lastSequence: -1 };

  it('never resumes from C while the current teaching W has actions (never restores old W)', () => {
    const courseState = buildCourseStateSnapshot(
      makeCourseSnapshotInput({
        idempotencyKey: 'seed-c',
        teachingActions: lessonOneClassroomHistory(),
      }),
    );
    expect(resolveResumeNodeId({ work: lessonOneClassroomHistory(), courseState })).toBeNull();
  });

  it('returns null before any course state snapshot exists (fresh course)', () => {
    expect(resolveResumeNodeId({ work: emptyWork, courseState: null })).toBeNull();
  });

  it('refuses to resume an archived course — 继续 only serves unfinished teaching', () => {
    const courseState = buildCourseStateSnapshot({
      ...makeCourseSnapshotInput({
        idempotencyKey: 'seed-c',
        teachingActions: lessonOneClassroomHistory(),
      }),
      lifecycle: { status: 'archived', updatedAt: NOW },
    });
    expect(resolveResumeNodeId({ work: emptyWork, courseState })).toBeNull();
  });

  it('resumes an in-progress course from the persisted unfinished position of C', () => {
    const courseState = buildCourseStateSnapshot(
      makeCourseSnapshotInput({
        idempotencyKey: 'seed-c',
        teachingActions: lessonOneClassroomHistory(),
      }),
    );
    expect(resolveResumeNodeId({ work: emptyWork, courseState })).toBe('node:lesson-1-b');
  });
});

describe('resolveCourseEntry（首页同课选择态 / 课后选择态投影，J4.4）', () => {
  function snapshotWith(overrides: {
    lifecycle?: { status: 'in_progress' | 'archived'; updatedAt: string };
    completedNodeIds?: string[];
  }): CourseStateSnapshot {
    const base = makeCourseSnapshotInput({ idempotencyKey: 'entry-seed' });
    return buildCourseStateSnapshot({
      ...base,
      ...(overrides.completedNodeIds?.length
        ? {
            progress: {
              completedNodeIds: overrides.completedNodeIds,
              lastCompletedNodeId: overrides.completedNodeIds.at(-1)!,
              updatedAt: NOW,
            },
          }
        : {}),
      ...(overrides.lifecycle ? { lifecycle: overrides.lifecycle } : {}),
    });
  }

  it('treats a legacy snapshot without lifecycle as in_progress and continuable', () => {
    const entry = resolveCourseEntry(snapshotWith({}));
    expect(entry.status).toBe('in_progress');
    expect(entry.canContinue).toBe(true);
    expect(entry.canReplay).toBe(false);
    expect(entry.resumeNodeId).toBe('node:lesson-1-b');
  });

  it('offers 再听 once a persisted taught range exists, even while in progress', () => {
    const entry = resolveCourseEntry(snapshotWith({ completedNodeIds: [NODE_A] }));
    expect(entry.canReplay).toBe(true);
    expect(entry.taughtNodeIds).toEqual([NODE_A]);
    expect(entry.canContinue).toBe(true);
  });

  it('refuses 继续 for an archived course and widens the replay range to the full lesson', () => {
    const entry = resolveCourseEntry(
      snapshotWith({
        lifecycle: { status: 'archived', updatedAt: NOW },
        completedNodeIds: [NODE_A],
      }),
    );
    expect(entry.status).toBe('archived');
    expect(entry.canContinue).toBe(false);
    expect(entry.canReplay).toBe(true);
    expect(entry.taughtNodeIds).toEqual([NODE_A, NODE_B]);
  });
});
