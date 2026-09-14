/**
 * A2 第一缝：课堂状态机 + 权威 `lesson.complete_node` 事件 + C 进度立即持久化。
 * 规格：docs/spec/04-detailed-design.md §1、docs/spec/05-development-plan.md A2、
 * docs/spec/01-user-journeys.md J3.1/J3.3 六列契约。
 */
import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@livecourse/storage';
import { describe, expect, it, vi } from 'vitest';

import {
  lessonCompletionEventSchema,
  lessonPlanSchema,
  teachingActionSchema,
  type LessonPlan,
  type TeachingAction,
} from '@/lib/livecourse/domain';
import {
  createTeachingActionRepository,
  livecourseActionSessionId,
  type TeachingActionRepository,
} from '@/lib/livecourse/session/action-repository';
import {
  ClassroomPresentationError,
  ClassroomStateError,
  LessonCompletionRejectedError,
  createClassroomController,
  type ClassroomCompletionDeps,
} from '@/lib/livecourse/session/controller';
import {
  createCourseStateRepository,
  type CourseStateRepository,
} from '@/lib/livecourse/session/course-state-repository';

import { COURSE_ID, LESSON_ONE, makeCourseSnapshotInput } from './course-state-fixture';

const STAGE_ID = 'stage-1';
const LEARNER_ID = 'learner-1';
const NODE_A = 'node:lesson-1-a';
const NODE_B = 'node:lesson-1-b';
const NODE_QUIZ = 'node:lesson-1-quiz';
const NOW = '2026-08-17T04:00:00.000Z';

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

const TWO_TEACHING_NODES = makeLessonPlan([
  {
    id: NODE_A,
    sceneId: 'scene:lesson-1-a',
    title: 'A',
    type: 'instruction',
    order: 0,
    goalIds: [],
  },
  {
    id: NODE_B,
    sceneId: 'scene:lesson-1-b',
    title: 'B',
    type: 'interactive',
    order: 1,
    goalIds: [],
  },
]);

const TEACHING_PLUS_CHECKPOINT = makeLessonPlan([
  {
    id: NODE_A,
    sceneId: 'scene:lesson-1-a',
    title: 'A',
    type: 'instruction',
    order: 0,
    goalIds: [],
  },
  {
    id: NODE_QUIZ,
    sceneId: 'scene:lesson-1-quiz',
    title: 'Q',
    type: 'checkpoint',
    order: 1,
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

interface SpeechCycle {
  startActionId: string;
  actionId: string;
  endActionId: string;
  nextSequence: number;
}

/** 提交一个完整教师回合：speech_start → 教学动作 → speech_end（全部成功结束）。 */
async function commitSpeechCycle(
  repository: TeachingActionRepository,
  nodeId: string,
  baseSequence: number,
): Promise<SpeechCycle> {
  const ids = {
    startActionId: `speech-start:${nodeId}`,
    actionId: `teach:${nodeId}`,
    endActionId: `speech-end:${nodeId}`,
  };
  await repository.append(
    action({
      id: ids.startActionId,
      nodeId,
      sequence: baseSequence,
      idempotencyKey: `key:${ids.startActionId}`,
      type: 'avatar.speech_start',
      payload: { text: '开始讲授这一节。' },
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
  return { ...ids, nextSequence: baseSequence + 3 };
}

async function setup(
  options: {
    lessonPlan?: LessonPlan;
    hasValidEvidence?: (nodeId: string) => boolean | Promise<boolean>;
    publishEvent?: ClassroomCompletionDeps['publishEvent'];
    applyPresentation?: (
      action: TeachingAction,
    ) => { success: true } | { success: false; error: string };
  } = {},
) {
  const store = new BrowserRuntimeStore({ dbName: `lesson-completion-${crypto.randomUUID()}` });
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
  let eventCounter = 0;
  const completion: ClassroomCompletionDeps = {
    classroomSessionId: livecourseActionSessionId({
      stageId: STAGE_ID,
      learnerId: LEARNER_ID,
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
    }),
    courseId: COURSE_ID,
    lessonId: LESSON_ONE,
    lessonPlan: options.lessonPlan ?? TWO_TEACHING_NODES,
    progressStore: courseState,
    hasValidEvidence: options.hasValidEvidence ?? (() => false),
    publishEvent: options.publishEvent,
    now: () => NOW,
    createEventId: () => `event-${eventCounter++}`,
  };
  const controller = createClassroomController({
    repository: actions,
    applyPresentation: options.applyPresentation ?? (() => ({ success: true as const })),
    publish: () => undefined,
    completion,
  });
  return { actions, controller, courseState, store };
}

/** 把动作日志快照带进 C，使 C 的初始快照与课堂一致。 */
async function seedCourseState(
  actions: TeachingActionRepository,
  courseState: CourseStateRepository,
): Promise<number> {
  const teachingActions = await actions.load();
  const saved = await courseState.save(makeCourseSnapshotInput({ teachingActions }));
  const versioned = await courseState.loadVersioned();
  expect(versioned?.snapshot.id).toBe(saved.id);
  return versioned!.revision;
}

describe('lesson.complete_node schema（A2 才新写，现有 schema 此前没有此事件）', () => {
  const validEvent = {
    schemaVersion: 1,
    type: 'lesson.complete_node',
    id: 'event-1',
    idempotencyKey: 'complete:node-a:1',
    classroomSessionId: 'session-1',
    courseId: COURSE_ID,
    lessonId: LESSON_ONE,
    nodeId: NODE_A,
    speech: { startActionId: 'speech-start-1', endActionId: 'speech-end-1' },
    actionIds: ['teach-1'],
    occurredAt: NOW,
  };

  it('parses a fully populated authoritative event', () => {
    const parsed = lessonCompletionEventSchema.parse(validEvent);
    expect(parsed.type).toBe('lesson.complete_node');
    expect(parsed.idempotencyKey).toBe('complete:node-a:1');
  });

  it.each([
    ['idempotencyKey', { ...validEvent, idempotencyKey: '' }],
    ['classroomSessionId', { ...validEvent, classroomSessionId: '' }],
    ['courseId', { ...validEvent, courseId: '' }],
    ['nodeId', { ...validEvent, nodeId: '' }],
    ['speech reference', { ...validEvent, speech: { startActionId: 'a' } }],
    ['action references', { ...validEvent, actionIds: [] }],
  ])('rejects an event without a valid %s', (_label, candidate) => {
    expect(lessonCompletionEventSchema.safeParse(candidate).success).toBe(false);
  });

  it('rejects mastery/evidence payloads — the event never represents mastery', () => {
    expect(lessonCompletionEventSchema.safeParse({ ...validEvent, score: 1 }).success).toBe(false);
    expect(
      lessonCompletionEventSchema.safeParse({ ...validEvent, evidenceId: 'ev-1' }).success,
    ).toBe(false);
  });

  it('is not part of the pre-existing teaching action schema', () => {
    expect(
      teachingActionSchema.safeParse({
        ...validEvent,
        sequence: 0,
        timestamp: NOW,
        payload: {},
      }).success,
    ).toBe(false);
  });
});

describe('ClassroomController lesson.complete_node', () => {
  it('submits only after speech and actions ended, updates W and persists C immediately', async () => {
    const { actions, controller, courseState } = await setup();
    const cycle = await commitSpeechCycle(actions, NODE_A, 0);
    const seedRevision = await seedCourseState(actions, courseState);
    await controller.load();

    const publishEvent = vi.fn();
    const result = await controller.completeNode({
      nodeId: NODE_A,
      idempotencyKey: 'complete:a:1',
      speech: { startActionId: cycle.startActionId, endActionId: cycle.endActionId },
      actionIds: [cycle.actionId],
    });

    expect(result.duplicate).toBe(false);
    expect(result.event).toMatchObject({
      type: 'lesson.complete_node',
      idempotencyKey: 'complete:a:1',
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
      nodeId: NODE_A,
      classroomSessionId: livecourseActionSessionId({
        stageId: STAGE_ID,
        learnerId: LEARNER_ID,
        courseId: COURSE_ID,
        lessonId: LESSON_ONE,
      }),
    });
    // W 幂等标记节点完成；非最后必需动作，不进入 completed。
    expect(controller.getCompletedNodeIds()).toEqual([NODE_A]);
    expect(result.state).toBe('teaching');

    // C.completedNode / C.progress 立即持久化，且可读出。
    const persisted = await courseState.loadVersioned();
    expect(persisted!.revision).toBe(seedRevision + 1);
    expect(persisted!.snapshot.progress).toEqual({
      completedNodeIds: [NODE_A],
      lastCompletedNodeId: NODE_A,
      updatedAt: NOW,
    });
    expect(persisted!.snapshot.idempotencyKey).toBe('lesson.complete_node:complete:a:1');
    void publishEvent;
  });

  it('rejects submission when the teacher speech has not reported a successful end', async () => {
    const { actions, controller, courseState } = await setup();
    // 只有 speech_start 与动作，没有 speech_end —— speech 未成功结束。
    await actions.append(
      action({
        id: 'speech-start-only',
        nodeId: NODE_A,
        sequence: 0,
        idempotencyKey: 'key:speech-start-only',
        type: 'avatar.speech_start',
        payload: { text: '讲到一半失败了。' },
      }),
    );
    await actions.append(
      action({ id: 'teach-a', nodeId: NODE_A, sequence: 1, idempotencyKey: 'key:teach-a' }),
    );
    await seedCourseState(actions, courseState);
    await controller.load();

    await expect(
      controller.completeNode({
        nodeId: NODE_A,
        idempotencyKey: 'complete:a:1',
        speech: { startActionId: 'speech-start-only', endActionId: 'speech-end-missing' },
        actionIds: ['teach-a'],
      }),
    ).rejects.toBeInstanceOf(LessonCompletionRejectedError);

    // 提交被拒绝：W 不推进、C 不持久化、状态与恢复点不变。
    expect(controller.getCompletedNodeIds()).toEqual([]);
    expect(controller.getState()).toBe('teaching');
    expect((await courseState.load())!.progress).toBeUndefined();
    expect(controller.getTransitions().filter((t) => t.to === 'completed')).toEqual([]);
  });

  it('rejects references to actions committed for another node', async () => {
    const { actions, controller } = await setup();
    const cycleA = await commitSpeechCycle(actions, NODE_A, 0);
    await controller.load();

    await expect(
      controller.completeNode({
        nodeId: NODE_B,
        idempotencyKey: 'complete:b:1',
        speech: { startActionId: cycleA.startActionId, endActionId: cycleA.endActionId },
        actionIds: [cycleA.actionId],
      }),
    ).rejects.toBeInstanceOf(LessonCompletionRejectedError);
    expect(controller.getCompletedNodeIds()).toEqual([]);
  });

  it('rejects unknown nodes and checkpoint nodes (checks complete via valid evidence)', async () => {
    const { actions, controller } = await setup({ lessonPlan: TEACHING_PLUS_CHECKPOINT });
    const cycleQuiz = await commitSpeechCycle(actions, NODE_QUIZ, 0);
    await controller.load();

    await expect(
      controller.completeNode({
        nodeId: 'node:unknown',
        idempotencyKey: 'complete:unknown:1',
        speech: { startActionId: cycleQuiz.startActionId, endActionId: cycleQuiz.endActionId },
        actionIds: [cycleQuiz.actionId],
      }),
    ).rejects.toBeInstanceOf(LessonCompletionRejectedError);

    await expect(
      controller.completeNode({
        nodeId: NODE_QUIZ,
        idempotencyKey: 'complete:quiz:1',
        speech: { startActionId: cycleQuiz.startActionId, endActionId: cycleQuiz.endActionId },
        actionIds: [cycleQuiz.actionId],
      }),
    ).rejects.toBeInstanceOf(LessonCompletionRejectedError);
    expect(controller.getCompletedNodeIds()).toEqual([]);
  });

  it('media playback arrival / load callbacks have no submission entry: dispatch alone never completes a node', async () => {
    const { actions, controller, courseState } = await setup();
    await seedCourseState(actions, courseState);
    await controller.load();

    // 播放壳 / 加载回调能到达的全部入口就是 dispatch 类型化动作；
    // 即使整个 speech 回合动作都提交成功，不调用 completeNode 就不会有完成事件。
    for (const dispatched of [
      action({
        id: 'd-0',
        sequence: 0,
        idempotencyKey: 'd-0',
        type: 'avatar.speech_start',
        payload: { text: '讲授。' },
      }),
      action({ id: 'd-1', sequence: 1, idempotencyKey: 'd-1' }),
      action({
        id: 'd-2',
        sequence: 2,
        idempotencyKey: 'd-2',
        type: 'avatar.speech_end',
        payload: {},
      }),
      action({
        id: 'd-3',
        sequence: 3,
        idempotencyKey: 'd-3',
        type: 'lesson.goto_node',
        payload: { targetNodeId: NODE_B },
      }),
    ]) {
      await controller.dispatch(dispatched);
    }

    expect(controller.getCompletedNodeIds()).toEqual([]);
    expect((await courseState.load())!.progress).toBeUndefined();
    expect(controller.getState()).toBe('teaching');
  });

  it('dedupes by idempotency key: W updates once and C persists once across retries', async () => {
    const { actions, controller, courseState } = await setup();
    const cycle = await commitSpeechCycle(actions, NODE_A, 0);
    const seedRevision = await seedCourseState(actions, courseState);
    const saveProgress = vi.spyOn(courseState, 'saveProgress');
    await controller.load();

    const input = {
      nodeId: NODE_A,
      idempotencyKey: 'complete:a:1',
      speech: { startActionId: cycle.startActionId, endActionId: cycle.endActionId },
      actionIds: [cycle.actionId],
    };
    const first = await controller.completeNode(input);
    const retry = await controller.completeNode(input);

    expect(first.duplicate).toBe(false);
    expect(retry.duplicate).toBe(true);
    expect(retry.event).toEqual(first.event);
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(controller.getCompletedNodeIds()).toEqual([NODE_A]);
    const persisted = await courseState.loadVersioned();
    expect(persisted!.revision).toBe(seedRevision + 1);
    expect(persisted!.snapshot.progress!.completedNodeIds).toEqual([NODE_A]);
  });

  it('rejects reuse of a committed idempotency key for a different node', async () => {
    const { actions, controller, courseState } = await setup();
    const cycleA = await commitSpeechCycle(actions, NODE_A, 0);
    const cycleB = await commitSpeechCycle(actions, NODE_B, cycleA.nextSequence);
    await seedCourseState(actions, courseState);
    await controller.load();

    await controller.completeNode({
      nodeId: NODE_A,
      idempotencyKey: 'complete:shared',
      speech: { startActionId: cycleA.startActionId, endActionId: cycleA.endActionId },
      actionIds: [cycleA.actionId],
    });

    await expect(
      controller.completeNode({
        nodeId: NODE_B,
        idempotencyKey: 'complete:shared',
        speech: { startActionId: cycleB.startActionId, endActionId: cycleB.endActionId },
        actionIds: [cycleB.actionId],
      }),
    ).rejects.toBeInstanceOf(LessonCompletionRejectedError);
    expect(controller.getCompletedNodeIds()).toEqual([NODE_A]);
  });

  it('rejects a same-key retry whose speech/action references changed', async () => {
    const { actions, controller, courseState } = await setup();
    const cycle = await commitSpeechCycle(actions, NODE_A, 0);
    await seedCourseState(actions, courseState);
    const saveProgress = vi.spyOn(courseState, 'saveProgress');
    await controller.load();

    const input = {
      nodeId: NODE_A,
      idempotencyKey: 'complete:a:stable',
      speech: { startActionId: cycle.startActionId, endActionId: cycle.endActionId },
      actionIds: [cycle.actionId],
    };
    await controller.completeNode(input);

    await expect(
      controller.completeNode({
        ...input,
        speech: { startActionId: cycle.startActionId, endActionId: 'speech-end:forged' },
      }),
    ).rejects.toBeInstanceOf(LessonCompletionRejectedError);
    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(controller.getCompletedNodeIds()).toEqual([NODE_A]);
  });

  it('rolls back W and keeps state/recovery point when C persistence fails; the retry persists once', async () => {
    const { actions, controller, courseState } = await setup();
    const cycle = await commitSpeechCycle(actions, NODE_A, 0);
    await seedCourseState(actions, courseState);
    await controller.load();
    const recoveryBefore = await controller.getRecoveryPoint();

    let failOnce = true;
    const realSaveProgress = courseState.saveProgress.bind(courseState);
    const saveProgress = vi
      .spyOn(courseState, 'saveProgress')
      .mockImplementation(async (input, options) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('runtime store unavailable');
        }
        return realSaveProgress(input, options);
      });

    const input = {
      nodeId: NODE_A,
      idempotencyKey: 'complete:a:1',
      speech: { startActionId: cycle.startActionId, endActionId: cycle.endActionId },
      actionIds: [cycle.actionId],
    };
    await expect(controller.completeNode(input)).rejects.toThrow('runtime store unavailable');

    // 失败保持原状态和恢复点，不推进节点。
    expect(controller.getState()).toBe('teaching');
    expect(controller.getCompletedNodeIds()).toEqual([]);
    expect(await controller.getRecoveryPoint()).toEqual(recoveryBefore);

    // 「重试当前节点」：同一 idempotency key 重试成功，只推进一次。
    const retry = await controller.completeNode(input);
    expect(retry.duplicate).toBe(false);
    expect(controller.getCompletedNodeIds()).toEqual([NODE_A]);
    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect((await courseState.load())!.progress!.completedNodeIds).toEqual([NODE_A]);
  });

  it('migrates completed → finalizing uniquely on the last required action only', async () => {
    const { actions, controller, courseState } = await setup();
    const cycleA = await commitSpeechCycle(actions, NODE_A, 0);
    const cycleB = await commitSpeechCycle(actions, NODE_B, cycleA.nextSequence);
    await seedCourseState(actions, courseState);
    const saveProgress = vi.spyOn(courseState, 'saveProgress');
    await controller.load();

    // 非最后必需动作 → 不进入 completed。
    const first = await controller.completeNode({
      nodeId: NODE_A,
      idempotencyKey: 'complete:a:1',
      speech: { startActionId: cycleA.startActionId, endActionId: cycleA.endActionId },
      actionIds: [cycleA.actionId],
    });
    expect(first.state).toBe('teaching');
    expect(controller.getTransitions().map((t) => `${t.from}->${t.to}`)).toEqual([
      'loading->teaching',
    ]);

    // 最后必需动作 → 唯一 completed → finalizing（J4.1 入口）。
    const last = await controller.completeNode({
      nodeId: NODE_B,
      idempotencyKey: 'complete:b:1',
      speech: { startActionId: cycleB.startActionId, endActionId: cycleB.endActionId },
      actionIds: [cycleB.actionId],
    });
    expect(last.state).toBe('finalizing');
    expect(controller.getTransitions().map((t) => `${t.from}->${t.to}`)).toEqual([
      'loading->teaching',
      'teaching->completed',
      'completed->finalizing',
    ]);

    // 唯一迁移：再次评估或重试都不会重复进入 completed / finalizing。
    await expect(controller.refreshCompletionGate()).resolves.toBe('finalizing');
    const retry = await controller.completeNode({
      nodeId: NODE_B,
      idempotencyKey: 'complete:b:1',
      speech: { startActionId: cycleB.startActionId, endActionId: cycleB.endActionId },
      actionIds: [cycleB.actionId],
    });
    expect(retry.duplicate).toBe(true);
    expect(retry.event).toEqual(last.event);
    expect(saveProgress).toHaveBeenCalledTimes(2);
    expect(controller.getTransitions()).toHaveLength(3);
  });

  it('blocks completion while a required checkpoint lacks valid evidence, then migrates once evidence arrives', async () => {
    let evidenceReady = false;
    const hasValidEvidence = vi.fn(() => evidenceReady);
    const { actions, controller, courseState } = await setup({
      lessonPlan: TEACHING_PLUS_CHECKPOINT,
      hasValidEvidence,
    });
    const cycleA = await commitSpeechCycle(actions, NODE_A, 0);
    await seedCourseState(actions, courseState);
    await controller.load();

    // 必要检查无有效 evidence → 最后讲授节点完成也不能进入 completed。
    const result = await controller.completeNode({
      nodeId: NODE_A,
      idempotencyKey: 'complete:a:1',
      speech: { startActionId: cycleA.startActionId, endActionId: cycleA.endActionId },
      actionIds: [cycleA.actionId],
    });
    expect(result.state).toBe('teaching');
    expect(hasValidEvidence).toHaveBeenCalledWith(NODE_QUIZ);
    await expect(controller.refreshCompletionGate()).resolves.toBe('teaching');
    expect(controller.getTransitions().filter((t) => t.to === 'completed')).toEqual([]);

    // 最后一个必要检查取得有效 evidence，补齐最后尚缺的必需动作 → 唯一迁移。
    evidenceReady = true;
    await expect(controller.refreshCompletionGate()).resolves.toBe('finalizing');
    expect(controller.getTransitions().map((t) => `${t.from}->${t.to}`)).toEqual([
      'loading->teaching',
      'teaching->completed',
      'completed->finalizing',
    ]);
  });

  it('pause blocks submission; dispatch failures keep the original state and recovery point', async () => {
    const { actions, controller, courseState } = await setup({
      applyPresentation: (dispatched) =>
        dispatched.type === 'stage.pointer'
          ? { success: false, error: 'missing element' }
          : { success: true },
    });
    const cycle = await commitSpeechCycle(actions, NODE_A, 0);
    await seedCourseState(actions, courseState);
    await controller.load();

    // 播放失败：不推进状态与恢复点。
    const before = await controller.getRecoveryPoint();
    await expect(
      controller.dispatch(
        action({
          id: 'pointer-fail',
          sequence: cycle.nextSequence,
          idempotencyKey: 'key:pointer-fail',
          type: 'stage.pointer',
          payload: { sceneId: 'scene:lesson-1-a' },
        }),
      ),
    ).rejects.toBeInstanceOf(ClassroomPresentationError);
    expect(controller.getState()).toBe('teaching');
    expect(await controller.getRecoveryPoint()).toEqual(before);
    expect(controller.getCompletedNodeIds()).toEqual([]);

    // 暂停态无权提交完成事件。
    await controller.dispatch(
      action({
        id: 'pause-1',
        sequence: cycle.nextSequence,
        idempotencyKey: 'key:pause-1',
        type: 'lesson.pause',
        payload: {},
      }),
    );
    expect(controller.getState()).toBe('paused');
    await expect(
      controller.completeNode({
        nodeId: NODE_A,
        idempotencyKey: 'complete:a:1',
        speech: { startActionId: cycle.startActionId, endActionId: cycle.endActionId },
        actionIds: [cycle.actionId],
      }),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(controller.getCompletedNodeIds()).toEqual([]);

    // 继续后恢复 teaching，提交生效。
    await controller.dispatch(
      action({
        id: 'resume-1',
        sequence: cycle.nextSequence + 1,
        idempotencyKey: 'key:resume-1',
        type: 'lesson.resume',
        payload: {},
      }),
    );
    expect(controller.getState()).toBe('teaching');
    const completed = await controller.completeNode({
      nodeId: NODE_A,
      idempotencyKey: 'complete:a:1',
      speech: { startActionId: cycle.startActionId, endActionId: cycle.endActionId },
      actionIds: [cycle.actionId],
    });
    expect(completed.duplicate).toBe(false);
  });

  it('load failure moves loading → failed with the recovery point intact, and a retry recovers', async () => {
    const { actions, controller } = await setup();
    await commitSpeechCycle(actions, NODE_A, 0);

    const loadSpy = vi.spyOn(actions, 'load').mockRejectedValueOnce(new Error('indexeddb blocked'));

    await expect(controller.load()).rejects.toThrow('indexeddb blocked');
    expect(controller.getState()).toBe('failed');
    expect(controller.getTransitions().map((t) => `${t.from}->${t.to}`)).toEqual([
      'loading->failed',
    ]);
    expect(controller.getCompletedNodeIds()).toEqual([]);

    loadSpy.mockRestore();
    await controller.load();
    expect(controller.getState()).toBe('teaching');
    expect(await controller.getRecoveryPoint()).toEqual({
      currentNodeId: NODE_A,
      lastSequence: 2,
    });
  });

  it('retries completion hydration after a transient C read failure without faking completion', async () => {
    const { actions, controller, courseState } = await setup();
    const teachingActions = await actions.load();
    await courseState.save({
      ...makeCourseSnapshotInput({ teachingActions }),
      progress: {
        completedNodeIds: [NODE_A],
        lastCompletedNodeId: NODE_A,
        updatedAt: NOW,
      },
    });

    const loadProgress = vi
      .spyOn(courseState, 'load')
      .mockRejectedValueOnce(new Error('transient C progress read failure'));

    await expect(controller.load()).rejects.toThrow('transient C progress read failure');
    // The failed C read is still a loading failure; no completed node was
    // projected and the classroom cannot claim the course is complete.
    expect(controller.getState()).toBe('failed');
    expect(controller.getCompletedNodeIds()).toEqual([]);
    expect(
      controller.getTransitions().map((transition) => `${transition.from}->${transition.to}`),
    ).toEqual(['loading->failed']);

    await controller.load();
    expect(loadProgress).toHaveBeenCalledTimes(2);
    expect(controller.getCompletedNodeIds()).toEqual([NODE_A]);
    expect(controller.getState()).toBe('teaching');
    expect(
      controller.getTransitions().map((transition) => `${transition.from}->${transition.to}`),
    ).toEqual(['loading->failed', 'failed->teaching']);
  });

  it('rehydrates W from persisted C after a coordinator restart; a retried event stays a no-op', async () => {
    const { actions, controller, courseState, store } = await setup();
    const cycle = await commitSpeechCycle(actions, NODE_A, 0);
    await seedCourseState(actions, courseState);
    await controller.load();
    await controller.completeNode({
      nodeId: NODE_A,
      idempotencyKey: 'complete:a:1',
      speech: { startActionId: cycle.startActionId, endActionId: cycle.endActionId },
      actionIds: [cycle.actionId],
    });
    const revisionAfterComplete = (await courseState.loadVersioned())!.revision;

    // 协调器重启：W 丢失，从 C 水合已完成节点。
    const saveProgress = vi.spyOn(courseState, 'saveProgress');
    const restarted = createClassroomController({
      repository: actions,
      applyPresentation: () => ({ success: true as const }),
      publish: () => undefined,
      completion: {
        classroomSessionId: livecourseActionSessionId({
          stageId: STAGE_ID,
          learnerId: LEARNER_ID,
          courseId: COURSE_ID,
          lessonId: LESSON_ONE,
        }),
        courseId: COURSE_ID,
        lessonId: LESSON_ONE,
        lessonPlan: TWO_TEACHING_NODES,
        progressStore: courseState,
        hasValidEvidence: () => false,
        now: () => NOW,
      },
    });
    expect(store).toBeDefined();
    await restarted.load();
    expect(restarted.getCompletedNodeIds()).toEqual([NODE_A]);

    const retry = await restarted.completeNode({
      nodeId: NODE_A,
      idempotencyKey: 'complete:a:1',
      speech: { startActionId: cycle.startActionId, endActionId: cycle.endActionId },
      actionIds: [cycle.actionId],
    });
    expect(retry.duplicate).toBe(true);
    expect(saveProgress).not.toHaveBeenCalled();
    expect((await courseState.loadVersioned())!.revision).toBe(revisionAfterComplete);
    expect(restarted.getCompletedNodeIds()).toEqual([NODE_A]);
  });

  it('does not forge a duplicate from C hydration when completion references are invalid', async () => {
    const { actions, controller, courseState } = await setup();
    const cycle = await commitSpeechCycle(actions, NODE_A, 0);
    const teachingActions = await actions.load();
    await courseState.save({
      ...makeCourseSnapshotInput({ teachingActions }),
      progress: {
        completedNodeIds: [NODE_A],
        lastCompletedNodeId: NODE_A,
        updatedAt: NOW,
      },
    });
    const saveProgress = vi.spyOn(courseState, 'saveProgress');
    await controller.load();

    await expect(
      controller.completeNode({
        nodeId: NODE_A,
        idempotencyKey: 'complete:a:forged',
        speech: { startActionId: cycle.startActionId, endActionId: 'speech-end:missing' },
        actionIds: [cycle.actionId],
      }),
    ).rejects.toBeInstanceOf(LessonCompletionRejectedError);
    expect(saveProgress).not.toHaveBeenCalled();
    expect(controller.getCompletedNodeIds()).toEqual([NODE_A]);
    expect(controller.getState()).toBe('teaching');
  });

  it('produces no EvidenceRecord and leaves the persisted evidence / goal projection inputs untouched', async () => {
    const { actions, controller, courseState } = await setup();
    const cycleA = await commitSpeechCycle(actions, NODE_A, 0);
    const cycleB = await commitSpeechCycle(actions, NODE_B, cycleA.nextSequence);
    await seedCourseState(actions, courseState);
    const evidenceBefore = (await courseState.load())!.evidence;
    await controller.load();

    await controller.completeNode({
      nodeId: NODE_A,
      idempotencyKey: 'complete:a:1',
      speech: { startActionId: cycleA.startActionId, endActionId: cycleA.endActionId },
      actionIds: [cycleA.actionId],
    });
    await controller.completeNode({
      nodeId: NODE_B,
      idempotencyKey: 'complete:b:1',
      speech: { startActionId: cycleB.startActionId, endActionId: cycleB.endActionId },
      actionIds: [cycleB.actionId],
    });
    expect(controller.getState()).toBe('finalizing');

    // C 只推进 completedNode / progress；evidence 事实源（GoalState 的唯一
    // 投影输入）原样保留——完成事件不产生证据、不投影掌握。
    const persisted = await courseState.load();
    expect(persisted!.evidence).toEqual(evidenceBefore);
    expect(persisted!.progress!.completedNodeIds).toEqual([NODE_A, NODE_B]);
  });
});
