/**
 * A2 第三缝：自然插话（J3.2）与课中重听（J3.6）的类型化命令边界。
 * 规格：docs/spec/04-detailed-design.md §1、docs/spec/01-user-journeys.md
 * J3.2 / J3.6 六列契约、docs/spec/05-development-plan.md A2 验收。
 *
 * 覆盖：
 * - `lesson.interrupt`：只在 teaching / checking 冻结 resumeNode（W 持久化），
 *   冻结点必须是当前节点；
 * - `lesson.resume_interrupted`：唯一回到 resumeNode 的显式命令，target 必须
 *   等于冻结点；幂等重试不重复迁移；
 * - interrupted / replaying 中 `lesson.goto_node` 被拒绝（不偷偷改线）；
 * - `lesson.relisten_start`：只覆盖已讲（已完成）范围，回放位置写 W；
 * - `lesson.relisten_end`：只能回到进入重听前的原位置与状态；
 * - 插话 / 重听不产生完成推进（不触发 completed / finalizing）；
 * - replaying / interrupted 中仍允许「暂时离开课堂」（J3.7）。
 */
import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@livecourse/storage';
import { describe, expect, it } from 'vitest';

import {
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
  ClassroomStateError,
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
    type: 'instruction',
    order: 1,
    goalIds: [],
  },
]);

let actionCounter = 0;

function nextAction(overrides: Partial<TeachingAction>): TeachingAction {
  actionCounter += 1;
  return teachingActionSchema.parse({
    schemaVersion: 1,
    id: `action-${actionCounter}`,
    courseId: COURSE_ID,
    lessonId: LESSON_ONE,
    nodeId: NODE_A,
    sequence: 0,
    timestamp: '2026-08-17T03:00:00.000Z',
    idempotencyKey: `key:action-${actionCounter}`,
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
): Promise<{ startActionId: string; actionId: string; endActionId: string; nextSequence: number }> {
  const ids = {
    startActionId: `speech-start:${nodeId}:${baseSequence}`,
    actionId: `teach:${nodeId}:${baseSequence}`,
    endActionId: `speech-end:${nodeId}:${baseSequence}`,
  };
  await repository.append(
    nextAction({
      id: ids.startActionId,
      nodeId,
      sequence: baseSequence,
      idempotencyKey: `key:${ids.startActionId}`,
      type: 'avatar.speech_start',
      payload: { text: '开始。' },
    }),
  );
  await repository.append(
    nextAction({
      id: ids.actionId,
      nodeId,
      sequence: baseSequence + 1,
      idempotencyKey: `key:${ids.actionId}`,
      type: 'stage.highlight',
      payload: { sceneId: `scene:${nodeId.slice(5)}`, elementId: 'el-1' },
    }),
  );
  await repository.append(
    nextAction({
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

interface Harness {
  actions: TeachingActionRepository;
  courseState: CourseStateRepository;
  controller: ReturnType<typeof createClassroomController>;
}

async function harness(): Promise<Harness> {
  const store = new BrowserRuntimeStore({ dbName: `interrupt-relisten-${crypto.randomUUID()}` });
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
  const completion: ClassroomCompletionDeps = {
    classroomSessionId: CLASSROOM_SESSION_ID,
    courseId: COURSE_ID,
    lessonId: LESSON_ONE,
    lessonPlan: TWO_TEACHING_NODES,
    progressStore: courseState,
    hasValidEvidence: () => false,
    now: () => NOW,
    createEventId: () => `event-${crypto.randomUUID()}`,
  };
  const controller = createClassroomController({
    repository: actions,
    applyPresentation: () => ({ success: true as const }),
    publish: () => undefined,
    completion,
    lifecycle: {
      classroomSessionId: CLASSROOM_SESSION_ID,
      courseState,
      destroyWorkSession: () => store.deleteSession(CLASSROOM_SESSION_ID),
    },
  });
  return { actions, courseState, controller };
}

/** 通过控制器提交命令：sequence 自动取 W 的下一个序号。 */
function dispatch(
  h: Harness,
  overrides: Partial<TeachingAction>,
): Promise<Awaited<ReturnType<Harness['controller']['dispatch']>>> {
  return h.actions
    .load()
    .then((snapshot) =>
      h.controller.dispatch(nextAction({ sequence: snapshot.lastSequence + 1, ...overrides })),
    );
}

/** 让 NODE_A 成为已讲节点：完整教师回合 + 权威 complete_node。 */
async function teachNodeA(h: Harness): Promise<void> {
  const cycle = await commitSpeechCycle(h.actions, NODE_A, 0);
  const snapshot = await h.actions.load();
  await h.courseState.save(makeCourseSnapshotInput({ teachingActions: snapshot }));
  await h.controller.load();
  await h.controller.completeNode({
    nodeId: NODE_A,
    idempotencyKey: 'complete:node-a',
    speech: { startActionId: cycle.startActionId, endActionId: cycle.endActionId },
    actionIds: [cycle.actionId],
  });
}

/** 把当前位置推进到 NODE_B（未讲）。 */
async function gotoNodeB(h: Harness): Promise<void> {
  await dispatch(h, {
    nodeId: NODE_B,
    type: 'lesson.goto_node',
    payload: { targetNodeId: NODE_B },
  });
}

describe('lesson.interrupt（J3.2 自然插话：冻结 resumeNode）', () => {
  it('freezes the current node as resumeNode and enters interrupted from teaching', async () => {
    const h = await harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);
    await h.controller.load();

    const result = await dispatch(h, {
      nodeId: NODE_A,
      type: 'lesson.interrupt',
      payload: { question: '为什么？' },
    });

    expect(result.duplicate).toBe(false);
    expect(result.state).toBe('interrupted');
    expect(result.recoveryPoint.currentNodeId).toBe(NODE_A);
    const work = await h.actions.load();
    expect(work.actions.at(-1)?.type).toBe('lesson.interrupt');
    expect(work.actions.at(-1)?.nodeId).toBe(NODE_A);
  });

  it('rejects interrupting from a node other than the current one', async () => {
    const h = await harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);
    await h.controller.load();

    await expect(
      dispatch(h, { nodeId: NODE_B, type: 'lesson.interrupt', payload: {} }),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(h.controller.getState()).toBe('teaching');
  });

  it('rejects goto_node while interrupted — only the explicit resume command returns', async () => {
    const h = await harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);
    await h.controller.load();
    await dispatch(h, { nodeId: NODE_A, type: 'lesson.interrupt', payload: {} });

    await expect(
      dispatch(h, { nodeId: NODE_B, type: 'lesson.goto_node', payload: { targetNodeId: NODE_B } }),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(h.controller.getState()).toBe('interrupted');
    expect((await h.controller.getRecoveryPoint()).currentNodeId).toBe(NODE_A);
  });

  it('resume_interrupted returns to the frozen resumeNode; duplicate retry does not re-migrate', async () => {
    const h = await harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);
    await h.controller.load();
    await dispatch(h, { nodeId: NODE_A, type: 'lesson.interrupt', payload: {} });
    // 教师回答（interrupted 中允许讲授类动作，不改线）。
    await dispatch(h, { nodeId: NODE_A, type: 'avatar.speech_start', payload: { text: '回答。' } });

    const resumeSnapshot = await h.actions.load();
    const resume = nextAction({
      nodeId: NODE_A,
      sequence: resumeSnapshot.lastSequence + 1,
      type: 'lesson.resume_interrupted',
      payload: { targetNodeId: NODE_A },
    });
    const result = await h.controller.dispatch(resume);
    expect(result.state).toBe('teaching');
    expect((await h.controller.getRecoveryPoint()).currentNodeId).toBe(NODE_A);

    const retry = await h.controller.dispatch(resume);
    expect(retry.duplicate).toBe(true);
    expect(retry.state).toBe('teaching');
  });

  it('rejects resume_interrupted to a node other than the frozen resumeNode', async () => {
    const h = await harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);
    await h.controller.load();
    await dispatch(h, { nodeId: NODE_A, type: 'lesson.interrupt', payload: {} });

    await expect(
      dispatch(h, {
        nodeId: NODE_B,
        type: 'lesson.resume_interrupted',
        payload: { targetNodeId: NODE_B },
      }),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(h.controller.getState()).toBe('interrupted');
  });

  it('interrupt from checking resumes back to checking', async () => {
    const h = await harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);
    await h.controller.load();
    await dispatch(h, {
      nodeId: NODE_A,
      type: 'checkpoint.open',
      payload: { checkpointId: 'cp-1' },
    });
    expect(h.controller.getState()).toBe('checking');

    await dispatch(h, { nodeId: NODE_A, type: 'lesson.interrupt', payload: {} });
    expect(h.controller.getState()).toBe('interrupted');

    await dispatch(h, {
      nodeId: NODE_A,
      type: 'lesson.resume_interrupted',
      payload: { targetNodeId: NODE_A },
    });
    expect(h.controller.getState()).toBe('checking');
  });

  it('rejects interrupting while paused', async () => {
    const h = await harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);
    await h.controller.load();
    await dispatch(h, { nodeId: NODE_A, type: 'lesson.pause', payload: {} });

    await expect(
      dispatch(h, { nodeId: NODE_A, type: 'lesson.interrupt', payload: {} }),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(h.controller.getState()).toBe('paused');
  });
});

describe('lesson.relisten（J3.6 课中重听：只覆盖已讲部分并回原位置）', () => {
  it('rejects relisten targets outside the taught range', async () => {
    const h = await harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);
    await h.controller.load();

    await expect(
      dispatch(h, {
        nodeId: NODE_A,
        type: 'lesson.relisten_start',
        payload: { targetNodeId: NODE_A },
      }),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(h.controller.getState()).toBe('teaching');
  });

  it('relisten a taught node enters replaying and end returns to the exact origin', async () => {
    const h = await harness();
    await teachNodeA(h);
    await gotoNodeB(h);
    expect(h.controller.getState()).toBe('teaching');
    expect((await h.controller.getRecoveryPoint()).currentNodeId).toBe(NODE_B);

    const start = await dispatch(h, {
      nodeId: NODE_A,
      type: 'lesson.relisten_start',
      payload: { targetNodeId: NODE_A },
    });
    expect(start.state).toBe('replaying');
    expect(start.recoveryPoint.currentNodeId).toBe(NODE_A);

    const endSnapshot = await h.actions.load();
    const end = nextAction({
      nodeId: NODE_B,
      sequence: endSnapshot.lastSequence + 1,
      type: 'lesson.relisten_end',
      payload: { targetNodeId: NODE_B },
    });
    const endResult = await h.controller.dispatch(end);
    expect(endResult.state).toBe('teaching');
    expect(endResult.recoveryPoint.currentNodeId).toBe(NODE_B);

    // 幂等重试：同一 key 直接判重，不再次迁移。
    const retry = await h.controller.dispatch(end);
    expect(retry.duplicate).toBe(true);
    expect(retry.state).toBe('teaching');
  });

  it('relisten from checking returns to checking', async () => {
    const h = await harness();
    await teachNodeA(h);
    await gotoNodeB(h);
    await dispatch(h, {
      nodeId: NODE_B,
      type: 'checkpoint.open',
      payload: { checkpointId: 'cp-1' },
    });

    await dispatch(h, {
      nodeId: NODE_A,
      type: 'lesson.relisten_start',
      payload: { targetNodeId: NODE_A },
    });
    expect(h.controller.getState()).toBe('replaying');

    await dispatch(h, {
      nodeId: NODE_B,
      type: 'lesson.relisten_end',
      payload: { targetNodeId: NODE_B },
    });
    expect(h.controller.getState()).toBe('checking');
  });

  it('rejects relisten_end when not replaying and goto_node while replaying', async () => {
    const h = await harness();
    await teachNodeA(h);

    await expect(
      dispatch(h, {
        nodeId: NODE_A,
        type: 'lesson.relisten_end',
        payload: { targetNodeId: NODE_A },
      }),
    ).rejects.toBeInstanceOf(ClassroomStateError);

    await dispatch(h, {
      nodeId: NODE_A,
      type: 'lesson.relisten_start',
      payload: { targetNodeId: NODE_A },
    });
    await expect(
      dispatch(h, { nodeId: NODE_B, type: 'lesson.goto_node', payload: { targetNodeId: NODE_B } }),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(h.controller.getState()).toBe('replaying');
  });

  it('relisten never advances completion — replaying the last taught node does not finalize', async () => {
    const h = await harness();
    await teachNodeA(h);

    await dispatch(h, {
      nodeId: NODE_A,
      type: 'lesson.relisten_start',
      payload: { targetNodeId: NODE_A },
    });
    await dispatch(h, {
      nodeId: NODE_A,
      type: 'lesson.relisten_end',
      payload: { targetNodeId: NODE_A },
    });
    // NODE_B 仍未讲：完成门不迁移，状态回到 teaching。
    expect(h.controller.getState()).toBe('teaching');
    expect(h.controller.getCompletedNodeIds()).toEqual([NODE_A]);
  });

  it('rejects relisten_end to a node other than the pre-relisten origin while replaying', async () => {
    const h = await harness();
    await teachNodeA(h);
    await gotoNodeB(h);
    await dispatch(h, {
      nodeId: NODE_A,
      type: 'lesson.relisten_start',
      payload: { targetNodeId: NODE_A },
    });
    expect(h.controller.getState()).toBe('replaying');

    // J3.6：只能回到进入重听前的原位置（NODE_B），改去别处必须被拒绝。
    await expect(
      dispatch(h, {
        nodeId: NODE_A,
        type: 'lesson.relisten_end',
        payload: { targetNodeId: NODE_A },
      }),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(h.controller.getState()).toBe('replaying');
    expect((await h.controller.getRecoveryPoint()).currentNodeId).toBe(NODE_A);
  });

  it('rejects relisten_start while interrupted and interrupt while replaying', async () => {
    const h = await harness();
    await teachNodeA(h);
    await gotoNodeB(h);

    // interrupted 中不能叠加课中重听。
    await dispatch(h, { nodeId: NODE_B, type: 'lesson.interrupt', payload: {} });
    await expect(
      dispatch(h, {
        nodeId: NODE_A,
        type: 'lesson.relisten_start',
        payload: { targetNodeId: NODE_A },
      }),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(h.controller.getState()).toBe('interrupted');

    await dispatch(h, {
      nodeId: NODE_B,
      type: 'lesson.resume_interrupted',
      payload: { targetNodeId: NODE_B },
    });
    expect(h.controller.getState()).toBe('teaching');

    // replaying 中不能叠加插话。
    await dispatch(h, {
      nodeId: NODE_A,
      type: 'lesson.relisten_start',
      payload: { targetNodeId: NODE_A },
    });
    await expect(
      dispatch(h, { nodeId: NODE_A, type: 'lesson.interrupt', payload: {} }),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(h.controller.getState()).toBe('replaying');
  });

  it('rejects relisten_start when nodeId differs from payload.targetNodeId', async () => {
    const h = await harness();
    await teachNodeA(h);

    await expect(
      dispatch(h, {
        nodeId: NODE_B,
        type: 'lesson.relisten_start',
        payload: { targetNodeId: NODE_A },
      }),
    ).rejects.toBeInstanceOf(ClassroomStateError);
    expect(h.controller.getState()).toBe('teaching');
  });
});

describe('interrupted / replaying 中的暂时离开（J3.7 与 J3.2/J3.6 的交叉）', () => {
  it('saveAndLeaveSession works from replaying: writes C, then destroys W', async () => {
    const h = await harness();
    await teachNodeA(h);
    await gotoNodeB(h);
    await dispatch(h, {
      nodeId: NODE_A,
      type: 'lesson.relisten_start',
      payload: { targetNodeId: NODE_A },
    });
    expect(h.controller.getState()).toBe('replaying');

    const result = await h.controller.saveAndLeaveSession();
    expect(result.duplicate).toBe(false);
    expect((await h.actions.load()).actions).toEqual([]);
    const snapshot = await h.courseState.load();
    expect(snapshot?.lifecycle?.status ?? 'in_progress').toBe('in_progress');
  });

  it('saveAndLeaveSession works from interrupted', async () => {
    const h = await harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);
    const snapshot = await h.actions.load();
    await h.courseState.save(makeCourseSnapshotInput({ teachingActions: snapshot }));
    await h.controller.load();
    await dispatch(h, { nodeId: NODE_A, type: 'lesson.interrupt', payload: {} });

    const result = await h.controller.saveAndLeaveSession();
    expect(result.duplicate).toBe(false);
    expect((await h.actions.load()).actions).toEqual([]);
  });

  it('hydrates an in-progress interrupted state and keeps the resumeNode position', async () => {
    const h = await harness();
    await commitSpeechCycle(h.actions, NODE_A, 0);
    await h.controller.load();
    // 插话不改变 currentNodeId：冻结点写进 W 后即使刷新也天然保留。
    await dispatch(h, { nodeId: NODE_A, type: 'lesson.interrupt', payload: {} });
    expect(h.controller.getState()).toBe('interrupted');

    // 模拟刷新：同一 W 上新建控制器，完整恢复 interrupted 与冻结点。
    const reloaded = createClassroomController({
      repository: h.actions,
      applyPresentation: () => ({ success: true as const }),
      publish: () => undefined,
    });
    const recovery = await reloaded.getRecoveryPoint();
    expect(reloaded.getState()).toBe('interrupted');
    expect(recovery.currentNodeId).toBe(NODE_A);
  });
});
