/**
 * Focused P-004 helpers: one fixture builds every recoverable component of a
 * course snapshot — course plan, committed classroom actions, assistant task
 * lifecycle, evidence and teaching adjustments — from the existing canonical
 * contracts. Kept intentionally small: the new tests only add what they need.
 */
import {
  AssistantTaskService,
  projectGoalState,
  teachingActionSchema,
  teachingAdjustmentSchema,
  type AssistantTaskSnapshot,
  type CoursePlan,
  type EvidenceRecord,
  type TeachingAction,
  type TeachingAdjustment,
} from '@/lib/livecourse/domain';
import {
  approveCourseAdjustment,
  rejectCourseAdjustment,
  TeachingAdjustmentEngine,
} from '@/lib/livecourse/domain/teaching-adjustment';
import type { TeachingActionSnapshot } from '@/lib/livecourse/session/action-repository';

import { makeAdjustmentCoursePlan, makeEvidenceRecord } from './evidence-fixture';

export const FIXED_NOW = '2026-08-17T01:00:00.000Z';
export const DECISION_NOW = '2026-08-17T02:00:00.000Z';

export const COURSE_ID = 'course:algebra';
export const LESSON_ONE = 'lesson-1';
export const LESSON_TWO = 'lesson-2';

function acceptedLessonOneEvidence(learnerId: string): EvidenceRecord {
  return makeEvidenceRecord({
    id: 'evidence-1',
    courseId: COURSE_ID,
    lessonId: LESSON_ONE,
    learnerId,
    goalId: 'goal:one',
    nodeId: 'node:lesson-1-a',
    score: 0.9,
    occurredAt: '2026-08-17T00:20:00.000Z',
    idempotencyKey: 'attempt-1',
  });
}

/**
 * Deterministic approved course change: an adjustment engine proposal for a
 * same-lesson retention checkpoint, decided by a teacher. Returns the plan
 * AFTER approval (version 4) and the approved adjustment record (target plan
 * version 3) — the recoverable applied course change.
 */
export function approvedCourseChange(learnerId = 'learner-1'): {
  coursePlan: CoursePlan;
  adjustment: TeachingAdjustment;
} {
  const basePlan = makeAdjustmentCoursePlan();
  const evidence = [acceptedLessonOneEvidence(learnerId)];
  const goal = basePlan.goals.find((candidate) => candidate.id === 'goal:one')!;
  const state = projectGoalState({
    courseId: basePlan.courseId,
    learnerId,
    goalId: goal.id,
    rule: goal.rule,
    evidence,
  });
  const engine = new TeachingAdjustmentEngine({ now: () => FIXED_NOW });
  const [proposal] = engine.proposeCourseAdjustments({
    coursePlan: basePlan,
    goalStates: [state],
    evidence,
  });
  if (!proposal) throw new Error('Fixture expected a course adjustment proposal');

  const coursePlan = approveCourseAdjustment({
    adjustment: proposal,
    coursePlan: basePlan,
    decidedBy: 'teacher:1',
    now: () => DECISION_NOW,
  });
  const adjustment = teachingAdjustmentSchema.parse({
    ...proposal,
    approvalStatus: 'approved',
    decidedAt: DECISION_NOW,
    decidedBy: 'teacher:1',
  });
  return { coursePlan, adjustment };
}

/** Pending and rejected proposals on the same course — audit history only. */
export function undecidedAdjustments(): TeachingAdjustment[] {
  const basePlan = makeAdjustmentCoursePlan();
  const pending = teachingAdjustmentSchema.parse({
    schemaVersion: 1,
    id: 'adjustment:pending-fixture',
    courseId: COURSE_ID,
    coursePlanVersion: basePlan.version,
    targetLessonIds: [LESSON_TWO],
    targetNodeIds: ['node:lesson-2-a'],
    basis: {
      evidenceIds: ['evidence-1'],
      goalStateIds: ['goal:one'],
      rationale: 'A retention checkpoint is proposed but the teacher has not decided yet.',
    },
    recommendation: {
      kind: 'add_checkpoint',
      summary: 'Confirm goal:one retention in lesson 2 before new material.',
      revision: {
        kind: 'add_checkpoint',
        checkpoint: {
          id: 'checkpoint:pending-fixture',
          nodeId: 'node:lesson-2-a',
          goalIds: ['goal:one'],
          required: true,
        },
      },
    },
    approvalStatus: 'pending',
    idempotencyKey: 'course-adjustment:pending-fixture',
    createdAt: FIXED_NOW,
  });
  const rejected = rejectCourseAdjustment({
    adjustment: teachingAdjustmentSchema.parse({
      schemaVersion: 1,
      id: 'adjustment:rejected-fixture',
      courseId: COURSE_ID,
      coursePlanVersion: basePlan.version,
      targetLessonIds: [LESSON_ONE],
      targetNodeIds: ['node:lesson-1-b'],
      basis: {
        evidenceIds: ['evidence-1'],
        goalStateIds: ['goal:one'],
        rationale: 'Fixture rejection record.',
      },
      recommendation: {
        kind: 'change_pacing',
        summary: 'Fixture rejected pacing proposal.',
      },
      approvalStatus: 'pending',
      idempotencyKey: 'course-adjustment:rejected-fixture',
      createdAt: FIXED_NOW,
    }),
    decidedBy: 'teacher:1',
    now: () => DECISION_NOW,
  });
  return [pending, rejected];
}

/** Committed classroom actions in lesson 1: two contiguous actions. */
export function lessonOneClassroomHistory(): TeachingActionSnapshot {
  const first = teachingActionSchema.parse({
    schemaVersion: 1,
    id: 'action-1',
    courseId: COURSE_ID,
    lessonId: LESSON_ONE,
    nodeId: 'node:lesson-1-a',
    sequence: 0,
    timestamp: '2026-08-17T00:30:00.000Z',
    idempotencyKey: 'classroom-0',
    type: 'stage.highlight',
    payload: { sceneId: 'scene:lesson-1-a', elementId: 'element-1' },
  });
  const second = teachingActionSchema.parse({
    schemaVersion: 1,
    id: 'action-2',
    courseId: COURSE_ID,
    lessonId: LESSON_ONE,
    nodeId: 'node:lesson-1-a',
    sequence: 1,
    timestamp: '2026-08-17T00:31:00.000Z',
    idempotencyKey: 'classroom-1',
    type: 'lesson.goto_node',
    payload: { targetNodeId: 'node:lesson-1-b' },
  });
  return {
    actions: [first, second] as readonly TeachingAction[],
    currentNodeId: 'node:lesson-1-b',
    lastSequence: 1,
  };
}

/** Queued, running, succeeded and cancelled tasks under one course. */
export function assistantTaskLifecycle(learnerId = 'learner-1'): AssistantTaskSnapshot {
  const service = new AssistantTaskService({ now: () => FIXED_NOW });
  void learnerId;

  service.create({
    schemaVersion: 1,
    courseId: COURSE_ID,
    lessonId: LESSON_ONE,
    nodeId: 'node:lesson-1-a',
    sceneId: 'scene:lesson-1-a',
    kind: 'suggest_next_step',
    delegatedBy: 'teacher-1',
    assistantId: 'assistant-1',
    inputRefs: ['lesson:lesson-1'],
    idempotencyKey: 'assistant-key-1',
  });

  const running = service.create({
    schemaVersion: 1,
    courseId: COURSE_ID,
    lessonId: LESSON_ONE,
    nodeId: 'node:lesson-1-a',
    sceneId: 'scene:lesson-1-a',
    kind: 'draft_board_note',
    delegatedBy: 'teacher-1',
    assistantId: 'assistant-1',
    inputRefs: ['source-1'],
    idempotencyKey: 'assistant-key-2',
  });
  service.start(running.id);

  const succeeded = service.create({
    schemaVersion: 1,
    courseId: COURSE_ID,
    lessonId: LESSON_ONE,
    nodeId: 'node:lesson-1-a',
    sceneId: 'scene:lesson-1-a',
    kind: 'draft_feedback',
    delegatedBy: 'teacher-1',
    assistantId: 'assistant-2',
    inputRefs: ['source-2'],
    idempotencyKey: 'assistant-key-3',
  });
  service.start(succeeded.id);
  service.succeed(succeeded.id, {
    kind: 'draft_feedback',
    summary: 'Feedback proposal prepared.',
    content: 'Encourage showing inverse operations in each step.',
  });

  const cancelled = service.create({
    schemaVersion: 1,
    courseId: COURSE_ID,
    lessonId: LESSON_ONE,
    nodeId: 'node:lesson-1-a',
    sceneId: 'scene:lesson-1-a',
    kind: 'summarize_source',
    delegatedBy: 'teacher-1',
    assistantId: 'assistant-3',
    inputRefs: ['source-3'],
    idempotencyKey: 'assistant-key-4',
  });
  service.cancel(cancelled.id, 'lesson moved on');

  return service.snapshot();
}

/** Accepted evidence plus one pending teacher review — a mixed ledger. */
export function evidenceLedger(learnerId = 'learner-1'): EvidenceRecord[] {
  return [
    acceptedLessonOneEvidence(learnerId),
    makeEvidenceRecord({
      id: 'evidence-2',
      courseId: COURSE_ID,
      lessonId: LESSON_ONE,
      learnerId,
      goalId: 'goal:one',
      nodeId: 'node:lesson-1-b',
      source: 'checkpoint',
      kind: 'rubric_score',
      status: 'pending_review',
      score: 0.6,
      occurredAt: '2026-08-17T00:40:00.000Z',
      idempotencyKey: 'quiz-review:attempt-2',
      evaluation: {
        method: 'model',
        modelId: 'configured-quiz-grader',
        rubricVersion: 'livecourse-short-answer-rubric-v1',
        inputSummary: 'A quiz containing model-graded answers was submitted.',
        confidence: 0,
        reviewStatus: 'pending',
      },
    }),
  ];
}

/** The complete recoverable snapshot input used by both P-004 suites. */
export function makeCourseSnapshotInput(
  overrides: {
    idempotencyKey?: string;
    stageId?: string;
    learnerId?: string;
    lessonId?: string;
    coursePlan?: CoursePlan;
    teachingActions?: TeachingActionSnapshot;
    assistantTasks?: AssistantTaskSnapshot;
    evidence?: readonly EvidenceRecord[];
    adjustments?: readonly TeachingAdjustment[];
  } = {},
) {
  const stageId = overrides.stageId ?? 'stage-1';
  const learnerId = overrides.learnerId ?? 'learner-1';
  const { coursePlan, adjustment } = approvedCourseChange(learnerId);
  return {
    idempotencyKey: overrides.idempotencyKey ?? 'snapshot-key-1',
    stageId,
    learnerId,
    courseId: COURSE_ID,
    lessonId: overrides.lessonId ?? LESSON_ONE,
    coursePlan: overrides.coursePlan ?? coursePlan,
    teachingActions: overrides.teachingActions ?? lessonOneClassroomHistory(),
    assistantTasks: overrides.assistantTasks ?? assistantTaskLifecycle(learnerId),
    evidence: overrides.evidence ?? evidenceLedger(learnerId),
    adjustments: overrides.adjustments ?? [adjustment],
  };
}
