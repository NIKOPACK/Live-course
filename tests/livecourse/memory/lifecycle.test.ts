import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@livecourse/storage';
import { describe, expect, it } from 'vitest';

import type { GoalState } from '@/lib/livecourse/domain';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  archiveWorkingMemoryIntoCourse,
  buildTeacherContext,
  collectLearnerProfileCandidates,
  createCourseMemoryRepository,
  createEmptyWorkingMemory,
  createLearnerMemoryRepository,
  createWorkingMemoryRepository,
  describeGoalMastery,
  finalizeSessionLearnerMemory,
  loadNewCourseMemoryContext,
  MULTI_COURSE_EVIDENCE_THRESHOLD,
  persistGenerationCourseIntake,
  type ClassroomWorkingMemory,
  type CourseIntake,
} from '@/lib/livecourse/memory';

const NOW = '2026-09-14T08:00:00.000Z';
const LATER = '2026-09-14T09:00:00.000Z';
const STAGE = 'stage-lifecycle';
const LEARNER = 'learner-lifecycle';
const COURSE = 'course-lifecycle';
const SESSION = 'classroom-session-lifecycle';

function store(): BrowserRuntimeStore {
  return new BrowserRuntimeStore({
    dbName: `memory-lifecycle-${crypto.randomUUID()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
}

function intake(requirement: string, answers: CourseIntake['preClassAnswers'] = []): CourseIntake {
  return {
    requirement,
    preClassAnswers: answers,
    finalScope: [requirement.slice(0, 500)],
    skipped: false,
    submittedAt: NOW,
  };
}

function working(overrides: Partial<ClassroomWorkingMemory> = {}): ClassroomWorkingMemory {
  return {
    ...createEmptyWorkingMemory({
      classroomSessionId: SESSION,
      stageId: STAGE,
      learnerId: LEARNER,
      courseId: COURSE,
      lessonId: 'lesson-1',
      now: NOW,
    }),
    ...overrides,
  };
}

function needsSupport(goalId: string): GoalState {
  return {
    schemaVersion: 1,
    courseId: COURSE,
    learnerId: LEARNER,
    goalId,
    ruleVersion: 'rule:v1',
    status: 'needs_support',
    evidenceIds: ['ev-support-1'],
    acceptedEvidenceCount: 1,
    pendingReviewCount: 0,
    passingEvidenceCount: 0,
    latestScore: 0.2,
    averageScore: 0.2,
    updatedAt: NOW,
  };
}

describe('collectLearnerProfileCandidates', () => {
  it('writes long-term / usual teaching preferences and ignores this-lesson-only wording', () => {
    const longTerm = collectLearnerProfileCandidates({
      intake: intake('我通常喜欢用图示、先例后理学新课'),
      now: NOW,
    });
    expect(longTerm.map((item) => `${item.dimension}:${item.value}`)).toEqual([
      'teaching_method:偏好图示',
      'teaching_method:先例后理',
    ]);
    expect(
      collectLearnerProfileCandidates({
        intake: intake('我通常喜欢用图示学新课，这堂课用图示、少公式教链式法则'),
        now: NOW,
      }).map((item) => item.value),
    ).toEqual(['偏好图示']);
    expect(longTerm.every((item) => item.source.type === 'explicit' && item.source.longTerm)).toBe(
      true,
    );

    expect(
      collectLearnerProfileCandidates({
        intake: intake('用图示、少公式教我链式法则'),
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('reads long-term markers from explicit expressions and pre-class answers', () => {
    const candidates = collectLearnerProfileCandidates({
      intake: intake('教我链式法则', [
        { questionId: 'q-pace', answer: '我一直以来都希望慢一点', answeredAt: NOW },
      ]),
      explicit: [{ label: '语言', value: '长期用中文上课' }],
      now: NOW,
    });
    expect(candidates.map((item) => `${item.dimension}:${item.value}`)).toEqual([
      'language:中文',
      'pace:慢一点',
    ]);
  });
});

describe('archiveWorkingMemoryIntoCourse', () => {
  it('archives open interruptions and needs_support goals into C without writing L', async () => {
    const s = store();
    const courseMemory = createCourseMemoryRepository({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER, courseId: COURSE },
      now: () => NOW,
    });
    const learnerMemory = createLearnerMemoryRepository({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER },
      now: () => NOW,
    });

    const first = await archiveWorkingMemoryIntoCourse({
      courseMemory,
      workingMemory: working({
        interruptions: [
          {
            id: 'interrupt-1',
            question: '极限和连续到底差在哪？',
            resumeNodeId: 'node:intro',
            status: 'open',
            occurredAt: NOW,
          },
          {
            id: 'interrupt-answered',
            question: '已经回答过的问题',
            resumeNodeId: 'node:intro',
            status: 'answered',
            occurredAt: NOW,
          },
        ],
      }),
      goalStates: [needsSupport('goal:chain-rule')],
      now: NOW,
    });

    expect(first?.unresolvedQuestions).toEqual([
      {
        id: 'interrupt-1',
        question: '极限和连续到底差在哪？',
        nodeId: 'node:intro',
        sourceSessionId: SESSION,
        archivedAt: NOW,
      },
    ]);
    expect(first?.misconceptions).toEqual([
      {
        id: 'misconception:goal:chain-rule',
        note: '不会：goal:chain-rule',
        evidenceIds: ['ev-support-1'],
        recordedAt: NOW,
      },
    ]);
    expect(await learnerMemory.load()).toBeUndefined();

    const retry = await archiveWorkingMemoryIntoCourse({
      courseMemory,
      workingMemory: working({
        interruptions: [
          {
            id: 'interrupt-1',
            question: '极限和连续到底差在哪？',
            resumeNodeId: 'node:intro',
            status: 'open',
            occurredAt: LATER,
          },
        ],
      }),
      goalStates: [needsSupport('goal:chain-rule')],
      now: LATER,
    });
    expect(retry?.unresolvedQuestions).toHaveLength(1);
    expect(retry?.misconceptions).toHaveLength(1);
  });

  it('does not create C when there is nothing to archive', async () => {
    const s = store();
    const courseMemory = createCourseMemoryRepository({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER, courseId: COURSE },
      now: () => NOW,
    });
    await expect(
      archiveWorkingMemoryIntoCourse({
        courseMemory,
        workingMemory: working(),
        goalStates: [],
        now: NOW,
      }),
    ).resolves.toBeUndefined();
    expect(await courseMemory.load()).toBeUndefined();
  });
});

describe('finalizeSessionLearnerMemory', () => {
  it('writes long-term L at finalization and keeps this-lesson methods out of L', async () => {
    const s = store();
    const courseMemory = createCourseMemoryRepository({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER, courseId: COURSE },
      now: () => NOW,
    });
    const learnerMemory = createLearnerMemoryRepository({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER },
      now: () => NOW,
    });
    await persistGenerationCourseIntake({
      store: s,
      stageId: STAGE,
      learnerId: LEARNER,
      courseId: COURSE,
      intake: intake('我通常喜欢用图示学新课，这堂课用图示、少公式教链式法则'),
      now: () => NOW,
    });

    const decisions = await finalizeSessionLearnerMemory({
      learnerMemory,
      courseMemory,
      workingMemory: working({
        interruptions: [
          {
            id: 'interrupt-open',
            question: '为什么复合函数要拆开？',
            resumeNodeId: 'node:chain',
            status: 'open',
            occurredAt: NOW,
          },
        ],
      }),
      goalStates: [needsSupport('goal:chain-rule')],
      now: () => LATER,
    });

    expect(decisions.some((item) => item.decision === 'write')).toBe(true);
    const stored = await learnerMemory.load();
    expect(stored?.entries.map((entry) => `${entry.dimension}:${entry.value}`)).toEqual([
      'teaching_method:偏好图示',
    ]);
    const archived = await courseMemory.load();
    expect(archived?.unresolvedQuestions.map((item) => item.question)).toEqual([
      '为什么复合函数要拆开？',
    ]);
    expect(archived?.misconceptions.map((item) => item.note)).toEqual(['不会：goal:chain-rule']);

    const newCourse = await loadNewCourseMemoryContext({
      store: s,
      stageId: 'stage-other',
      learnerId: LEARNER,
    });
    expect(newCourse.teacherContext.text).toContain('偏好图示');
    expect(newCourse.teacherContext.text).not.toContain('链式法则');
    expect(newCourse.teacherContext.text).not.toContain('复合函数');
    expect(newCourse.teacherContext.text).not.toContain(COURSE);
  });

  it('writes multi-course evidence at finalization and refreshes provenance, but skips a single course', async () => {
    const s = store();
    const courseMemory = createCourseMemoryRepository({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER, courseId: COURSE },
      now: () => NOW,
    });
    const learnerMemory = createLearnerMemoryRepository({
      store: s,
      scope: { learnerId: LEARNER },
      now: () => NOW,
    });

    const skipped = await finalizeSessionLearnerMemory({
      learnerMemory,
      courseMemory,
      extraCandidates: [
        {
          dimension: 'pace',
          value: '慢一点',
          source: { type: 'behavioral', independentCourseCount: 1 },
          confidence: 0.6,
          observedAt: NOW,
        },
      ],
      now: () => NOW,
    });
    expect(skipped.map((item) => item.decision)).toEqual(['skip-insufficient-evidence']);
    expect(await learnerMemory.load()).toBeUndefined();

    const written = await finalizeSessionLearnerMemory({
      learnerMemory,
      courseMemory,
      extraCandidates: [
        {
          dimension: 'pace',
          value: '慢一点',
          source: {
            type: 'behavioral',
            independentCourseCount: MULTI_COURSE_EVIDENCE_THRESHOLD,
          },
          confidence: 0.7,
          observedAt: NOW,
        },
      ],
      now: () => NOW,
    });
    expect(written.map((item) => item.decision)).toEqual(['write']);
    expect((await learnerMemory.load())?.entries).toEqual([
      expect.objectContaining({
        dimension: 'pace',
        value: '慢一点',
        sourceType: 'multi_course_evidence',
        supportingCourseCount: MULTI_COURSE_EVIDENCE_THRESHOLD,
        confidence: 0.7,
      }),
    ]);

    const refreshed = await finalizeSessionLearnerMemory({
      learnerMemory,
      courseMemory,
      extraCandidates: [
        {
          dimension: 'pace',
          value: '慢一点',
          source: { type: 'behavioral', independentCourseCount: 3 },
          confidence: 0.85,
          observedAt: LATER,
        },
      ],
      now: () => LATER,
    });
    expect(refreshed.map((item) => item.decision)).toEqual(['update']);
    expect((await learnerMemory.load())?.entries).toEqual([
      expect.objectContaining({
        supportingCourseCount: 3,
        confidence: 0.85,
        updatedAt: LATER,
        observedAt: NOW,
      }),
    ]);
  });

  it('archives W into C then destroys W without writing L', async () => {
    const s = store();
    const courseMemory = createCourseMemoryRepository({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER, courseId: COURSE },
      now: () => NOW,
    });
    const learnerMemory = createLearnerMemoryRepository({
      store: s,
      scope: { learnerId: LEARNER },
      now: () => NOW,
    });
    const workingMemory = createWorkingMemoryRepository({
      store: s,
      scope: {
        stageId: STAGE,
        learnerId: LEARNER,
        classroomSessionId: SESSION,
        courseId: COURSE,
        lessonId: 'lesson-1',
      },
      now: () => NOW,
    });
    const snapshot = await workingMemory.update((current) => ({
      ...current,
      interruptions: [
        {
          id: 'interrupt-leave',
          question: '极限为什么能换成导数？',
          resumeNodeId: 'node:intro',
          status: 'open',
          occurredAt: NOW,
        },
      ],
    }));

    await archiveWorkingMemoryIntoCourse({
      courseMemory,
      workingMemory: snapshot,
      now: NOW,
    });
    expect(await learnerMemory.load()).toBeUndefined();
    await workingMemory.destroy();

    expect(await workingMemory.load()).toBeUndefined();
    expect((await courseMemory.load())?.unresolvedQuestions.map((item) => item.question)).toEqual([
      '极限为什么能换成导数？',
    ]);
    expect(await learnerMemory.load()).toBeUndefined();
  });
});

describe('describeGoalMastery', () => {
  it('renders 会 / 不会 for the teacher short context', () => {
    expect(describeGoalMastery('met')).toBe('会');
    expect(describeGoalMastery('needs_support')).toBe('不会');
    expect(
      buildTeacherContext({
        mode: 'resume-same-course',
        courseMemory: {
          stageId: STAGE,
          learnerId: LEARNER,
          courseId: COURSE,
          misconceptions: [],
          unresolvedQuestions: [],
          evidenceTailRevision: 0,
          evidence: [],
          goalStates: [needsSupport('goal:chain-rule')],
        },
      }).text,
    ).toContain('Goal goal:chain-rule: 不会');
  });
});
