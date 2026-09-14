import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@livecourse/storage';
import { describe, expect, it } from 'vitest';

import type { EvidenceRecord } from '@/lib/livecourse/domain';
import { appendEvidenceRecord } from '@/lib/livecourse/evidence/runtime-repository';
import {
  applyPolicyDecisions,
  buildTeacherContext,
  courseMemorySessionId,
  createCourseMemoryRepository,
  createEmptyLearnerMemory,
  createLearnerMemoryRepository,
  createWorkingMemoryRepository,
  evaluateCandidates,
  filterInjectibleLearnerEntries,
  finalizeLearnerMemoryWithPolicy,
  learnerMemorySchema,
  LEARNER_MEMORY_PARTITION_STAGE_ID,
  learnerMemorySessionId,
  loadCourseLearningMemory,
  MAX_TOTAL_CONTEXT_CHARS,
  MemoryPartitionError,
  MemorySessionNotActiveError,
  MissingCourseIdError,
  MULTI_COURSE_EVIDENCE_THRESHOLD,
  workingMemorySessionId,
  type CourseLearningMemory,
  type LearnerMemoryEntry,
  type LearnerProfileCandidate,
} from '@/lib/livecourse/memory';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';

const NOW = '2026-08-22T07:00:00.000Z';
const LATER = '2026-08-22T08:00:00.000Z';
const STAGE = 'stage-1';
const LEARNER_A = 'learner-a';
const LEARNER_B = 'learner-b';
const COURSE_A = 'course-a';
const COURSE_B = 'course-b';

function store(dbName: string): BrowserRuntimeStore {
  return new BrowserRuntimeStore({ dbName, payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS });
}

function makeEvidence(input: {
  id: string;
  courseId: string;
  learnerId: string;
  goalId?: string;
}): EvidenceRecord {
  return {
    schemaVersion: 1,
    id: input.id,
    courseId: input.courseId,
    lessonId: 'lesson-1',
    learnerId: input.learnerId,
    goalId: input.goalId ?? 'goal-1',
    nodeId: 'node:quiz-1',
    source: 'checkpoint',
    kind: 'objective_score',
    status: 'accepted',
    score: 0.8,
    occurredAt: NOW,
    idempotencyKey: `key:${input.id}`,
    evaluation: { method: 'deterministic', ruleVersion: 'rule:v1' },
  };
}

// ──────────────────────────────────────────────
//  namespaces：fail closed 与作用域隔离
// ──────────────────────────────────────────────

describe('memory namespaces', () => {
  it('fails closed when a course-scoped id is built without a courseId', () => {
    expect(() =>
      courseMemorySessionId({ stageId: STAGE, learnerId: LEARNER_A, courseId: '' }),
    ).toThrow(MissingCourseIdError);
    expect(() =>
      courseMemorySessionId({ stageId: STAGE, learnerId: LEARNER_A, courseId: '   ' }),
    ).toThrow(MissingCourseIdError);
  });

  it('builds distinct ids per scope and per tenant', () => {
    const w = workingMemorySessionId({
      stageId: STAGE,
      learnerId: LEARNER_A,
      classroomSessionId: 'session-1',
    });
    const c = courseMemorySessionId({ stageId: STAGE, learnerId: LEARNER_A, courseId: COURSE_A });
    const l = learnerMemorySessionId({ stageId: STAGE, learnerId: LEARNER_A });
    expect(new Set([w, c, l]).size).toBe(3);
    expect(c).not.toBe(
      courseMemorySessionId({ stageId: STAGE, learnerId: LEARNER_A, courseId: COURSE_B }),
    );
    expect(l).not.toBe(learnerMemorySessionId({ stageId: STAGE, learnerId: LEARNER_B }));
  });

  it('keeps learner-only identity stable across classroom stages', () => {
    expect(learnerMemorySessionId({ stageId: 'stage-algebra', learnerId: LEARNER_A })).toBe(
      learnerMemorySessionId({ stageId: 'stage-history', learnerId: LEARNER_A }),
    );
    expect(learnerMemorySessionId({ stageId: 'stage-algebra', learnerId: LEARNER_A })).not.toBe(
      learnerMemorySessionId({ stageId: 'stage-algebra', learnerId: LEARNER_B }),
    );
  });

  it('uses a reserved physical stage rather than the route stage for L', () => {
    // The RuntimeStore still needs a stage partition key, but it must be
    // deterministic and independent of whichever classroom opened the repo.
    expect(LEARNER_MEMORY_PARTITION_STAGE_ID).toBe('__livecourse:learner-memory__');
  });
});

// ──────────────────────────────────────────────
//  schemas：L 是严格白名单
// ──────────────────────────────────────────────

describe('learner memory schema whitelist', () => {
  const base = createEmptyLearnerMemory({ stageId: STAGE, learnerId: LEARNER_A, now: NOW });

  it('rejects non-whitelisted dimensions', () => {
    for (const dimension of ['mastery', 'topic_level', 'course_summary', 'quiz_score']) {
      const result = learnerMemorySchema.safeParse({
        ...base,
        entries: [
          {
            schemaVersion: 1,
            id: 'e1',
            dimension,
            value: 'advanced',
            sourceType: 'explicit_longterm',
            supportingCourseCount: 1,
            confidence: 0.9,
            observedAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
      expect(result.success).toBe(false);
    }
  });

  it('rejects entries carrying course-content fields (strict object)', () => {
    const result = learnerMemorySchema.safeParse({
      ...base,
      entries: [
        {
          schemaVersion: 1,
          id: 'e1',
          dimension: 'language',
          value: '中文',
          sourceType: 'explicit_longterm',
          supportingCourseCount: 1,
          confidence: 0.9,
          observedAt: NOW,
          updatedAt: NOW,
          courseId: COURSE_A, // 课程内容在结构上无处存放
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

// ──────────────────────────────────────────────
//  repository：三层隔离 + C 组合视图
// ──────────────────────────────────────────────

describe('memory repositories over RuntimeStore', () => {
  it('fails closed on a mismatched or inactive RuntimeSession at every boundary', async () => {
    const mismatchedStore = store(`memory-session-identity-${crypto.randomUUID()}`);
    const mismatched = createLearnerMemoryRepository({
      store: mismatchedStore,
      scope: { stageId: STAGE, learnerId: LEARNER_A },
      now: () => NOW,
    });
    const learnerSessionId = learnerMemorySessionId({ stageId: STAGE, learnerId: LEARNER_A });
    await mismatchedStore.createSession({
      id: learnerSessionId,
      kind: 'unrelated-runtime-kind',
      stageId: LEARNER_MEMORY_PARTITION_STAGE_ID,
      learnerKey: LEARNER_A,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await expect(mismatched.load()).rejects.toBeInstanceOf(MemoryPartitionError);
    await expect(mismatched.update((current) => current)).rejects.toBeInstanceOf(
      MemoryPartitionError,
    );
    await expect(mismatched.destroy()).rejects.toBeInstanceOf(MemoryPartitionError);

    const inactiveStore = store(`memory-session-inactive-${crypto.randomUUID()}`);
    const inactive = createLearnerMemoryRepository({
      store: inactiveStore,
      scope: { stageId: STAGE, learnerId: LEARNER_A },
      now: () => NOW,
    });
    await inactiveStore.createSession({
      id: learnerSessionId,
      kind: 'livecourseLearnerMemory',
      stageId: LEARNER_MEMORY_PARTITION_STAGE_ID,
      learnerKey: LEARNER_A,
      status: 'completed',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await expect(inactive.load()).rejects.toBeInstanceOf(MemorySessionNotActiveError);
    await expect(inactive.update((current) => current)).rejects.toBeInstanceOf(
      MemorySessionNotActiveError,
    );
    await expect(inactive.destroy()).rejects.toBeInstanceOf(MemorySessionNotActiveError);
  });

  it('isolates W / C / L across learners and courses', async () => {
    const s = store(`memory-iso-${crypto.randomUUID()}`);
    const learnerA = createLearnerMemoryRepository({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER_A },
      now: () => NOW,
    });
    const learnerB = createLearnerMemoryRepository({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER_B },
      now: () => NOW,
    });
    const courseA = createCourseMemoryRepository({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER_A, courseId: COURSE_A },
      now: () => NOW,
    });
    const courseB = createCourseMemoryRepository({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER_A, courseId: COURSE_B },
      now: () => NOW,
    });

    await learnerA.update((memory) => ({
      ...memory,
      entries: [
        {
          schemaVersion: 1,
          id: 'learner-entry:x',
          dimension: 'pace',
          value: '慢一点',
          sourceType: 'explicit_longterm',
          supportingCourseCount: 1,
          confidence: 0.9,
          observedAt: NOW,
          updatedAt: NOW,
        },
      ],
    }));
    await courseA.update((record) => ({
      ...record,
      unresolvedQuestions: [
        {
          id: 'q1',
          question: '为什么这里要用 await？',
          sourceSessionId: 'session-1',
          archivedAt: NOW,
        },
      ],
    }));

    // 学习者隔离：B 看不到 A 的画像。
    expect((await learnerB.load())?.entries ?? []).toEqual([]);
    // 课程隔离：course-b 看不到 course-a 的未解决问题。
    expect((await courseB.load())?.unresolvedQuestions ?? []).toEqual([]);
    expect((await learnerA.load())?.entries).toHaveLength(1);
    expect((await courseA.load())?.unresolvedQuestions).toHaveLength(1);
  });

  it('reuses L across stages for one learner while keeping other learners isolated', async () => {
    const s = store(`memory-cross-stage-${crypto.randomUUID()}`);
    const stageOne = createLearnerMemoryRepository({
      store: s,
      scope: { stageId: 'stage-one', learnerId: LEARNER_A },
      now: () => NOW,
    });
    const stageTwo = createLearnerMemoryRepository({
      store: s,
      scope: { stageId: 'stage-two', learnerId: LEARNER_A },
      now: () => NOW,
    });
    const otherLearner = createLearnerMemoryRepository({
      store: s,
      scope: { stageId: 'stage-two', learnerId: LEARNER_B },
      now: () => NOW,
    });

    await stageOne.update((memory) => ({
      ...memory,
      entries: [
        {
          schemaVersion: 1,
          id: 'learner-entry:cross-stage',
          dimension: 'teaching_method',
          value: '先例后理',
          sourceType: 'explicit_longterm',
          supportingCourseCount: 1,
          confidence: 0.95,
          observedAt: NOW,
          updatedAt: NOW,
        },
      ],
    }));

    expect((await stageTwo.load())?.entries.map((entry) => entry.value)).toEqual(['先例后理']);
    expect(await otherLearner.load()).toBeUndefined();
    // L is in the reserved partition, so deleting one classroom stage cannot
    // erase the learner-wide profile.
    await s.deleteStageRuntime('stage-one');
    expect((await stageTwo.load())?.entries.map((entry) => entry.value)).toEqual(['先例后理']);
  });

  it('does not let one course leak through the learner-only context', async () => {
    const s = store(`memory-cross-course-negative-${crypto.randomUUID()}`);
    const learner = createLearnerMemoryRepository({
      store: s,
      scope: { stageId: 'stage-course-a', learnerId: LEARNER_A },
      now: () => NOW,
    });
    const courseA = createCourseMemoryRepository({
      store: s,
      scope: { stageId: 'stage-course-a', learnerId: LEARNER_A, courseId: COURSE_A },
      now: () => NOW,
    });

    await courseA.update((record) => ({
      ...record,
      intake: {
        requirement: '课程 A 的秘密需求',
        preClassAnswers: [],
        finalScope: ['只属于课程 A 的知识点'],
        skipped: false,
        submittedAt: NOW,
      },
      unresolvedQuestions: [
        {
          id: 'course-a-question',
          question: '课程 A 的原始问题',
          sourceSessionId: 'course-a-session',
          archivedAt: NOW,
        },
      ],
    }));
    await learner.update((memory) => ({
      ...memory,
      entries: [
        {
          schemaVersion: 1,
          id: 'learner-entry:pace-cross-course',
          dimension: 'pace',
          value: '慢一点',
          sourceType: 'explicit_longterm',
          supportingCourseCount: 1,
          confidence: 0.9,
          observedAt: NOW,
          updatedAt: NOW,
        },
      ],
    }));

    const context = buildTeacherContext({
      mode: 'new-course',
      // This simulates a caller accidentally retaining C from course A.  The
      // context contract must still refuse to render it in new-course mode.
      courseMemory: {
        ...(await loadCourseLearningMemory({
          store: s,
          scope: { stageId: 'stage-course-a', learnerId: LEARNER_A, courseId: COURSE_A },
          courseState: { load: async () => undefined },
        })),
      },
      learnerMemory: await learner.load(),
    });

    expect(context.text).toContain('慢一点');
    expect(context.text).not.toContain('课程 A 的秘密需求');
    expect(context.text).not.toContain('课程 A 的原始问题');
    expect(context.text).not.toContain('只属于课程 A 的知识点');
  });

  it('destroys W idempotently and never resurrects archived temp state', async () => {
    const s = store(`memory-w-${crypto.randomUUID()}`);
    const repo = createWorkingMemoryRepository({
      store: s,
      scope: {
        stageId: STAGE,
        learnerId: LEARNER_A,
        classroomSessionId: 'session-1',
        courseId: COURSE_A,
        lessonId: 'lesson-1',
      },
      now: () => NOW,
    });
    await repo.update((memory) => ({ ...memory, shortSummary: '讲到第二节点' }));
    expect((await repo.load())?.shortSummary).toBe('讲到第二节点');
    await repo.destroy();
    await repo.destroy();
    expect(await repo.load()).toBeUndefined();
  });

  it('composes the full C view from record + authoritative evidence stream', async () => {
    const s = store(`memory-c-${crypto.randomUUID()}`);
    await appendEvidenceRecord(
      STAGE,
      makeEvidence({ id: 'ev-a1', courseId: COURSE_A, learnerId: LEARNER_A }),
      { store: s, learnerId: LEARNER_A, courseId: COURSE_A },
    );
    await appendEvidenceRecord(
      STAGE,
      makeEvidence({ id: 'ev-b1', courseId: COURSE_B, learnerId: LEARNER_A }),
      { store: s, learnerId: LEARNER_A, courseId: COURSE_B },
    );
    const repo = createCourseMemoryRepository({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER_A, courseId: COURSE_A },
      now: () => NOW,
    });
    await repo.update((record) => ({
      ...record,
      intake: {
        requirement: '想学 Python 基础',
        preClassAnswers: [],
        finalScope: ['变量', '循环'],
        skipped: false,
        submittedAt: NOW,
      },
    }));

    const view = await loadCourseLearningMemory({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER_A, courseId: COURSE_A },
      courseState: { load: async () => undefined },
      goalRules: {
        'goal-1': {
          version: 'rule:v1',
          passScore: 0.7,
          minAcceptedEvidence: 1,
          minPassingEvidence: 1,
        },
      },
    });

    expect(view.intake?.requirement).toBe('想学 Python 基础');
    // 只含本课程证据；course-b 的证据不串进来。
    expect(view.evidence.map((item) => item.id)).toEqual(['ev-a1']);
    expect(view.evidenceTailRevision).toBe(1);
    expect(view.goalStates).toHaveLength(1);
    expect(view.goalStates[0]?.status).toBe('met');
  });

  it('fails closed when loading C without a courseId', async () => {
    const s = store(`memory-c-fail-${crypto.randomUUID()}`);
    await expect(
      loadCourseLearningMemory({
        store: s,
        scope: { stageId: STAGE, learnerId: LEARNER_A, courseId: '' },
        courseState: { load: async () => undefined },
      }),
    ).rejects.toThrow(MissingCourseIdError);
  });
});

// ──────────────────────────────────────────────
//  policy：确定性白名单写入
// ──────────────────────────────────────────────

function candidate(partial: Partial<LearnerProfileCandidate>): LearnerProfileCandidate {
  return {
    dimension: 'pace',
    value: '慢一点',
    source: { type: 'explicit', longTerm: true },
    confidence: 0.9,
    observedAt: NOW,
    ...partial,
  };
}

describe('learner memory policy', () => {
  it('writes explicit long-term preferences at finalization', async () => {
    const s = store(`policy-lt-${crypto.randomUUID()}`);
    const repo = createLearnerMemoryRepository({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER_A },
      now: () => NOW,
    });
    const decisions = await finalizeLearnerMemoryWithPolicy({
      learnerMemory: repo,
      candidates: [candidate({})],
      now: () => LATER,
    });
    expect(decisions[0]?.decision).toBe('write');
    const stored = await repo.load();
    expect(stored?.entries).toHaveLength(1);
    expect(stored?.entries[0]?.sourceType).toBe('explicit_longterm');
    expect(stored?.entries[0]?.updatedAt).toBe(LATER);
  });

  it('never writes non-long-term explicit preferences, even at finalization', async () => {
    const s = store(`policy-short-${crypto.randomUUID()}`);
    const repo = createLearnerMemoryRepository({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER_A },
      now: () => NOW,
    });
    const decisions = await finalizeLearnerMemoryWithPolicy({
      learnerMemory: repo,
      candidates: [candidate({ source: { type: 'explicit', longTerm: false } })],
    });
    expect(decisions[0]?.decision).toBe('skip-not-longterm');
    expect((await repo.load())?.entries ?? []).toEqual([]);
  });

  it('requires multi-course independent evidence for behavioral labels', async () => {
    const s = store(`policy-beh-${crypto.randomUUID()}`);
    const repo = createLearnerMemoryRepository({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER_A },
      now: () => NOW,
    });
    // 单次行为不能形成永久标签。
    const single = await finalizeLearnerMemoryWithPolicy({
      learnerMemory: repo,
      candidates: [candidate({ source: { type: 'behavioral', independentCourseCount: 1 } })],
    });
    expect(single[0]?.decision).toBe('skip-insufficient-evidence');
    expect((await repo.load())?.entries ?? []).toEqual([]);

    // 达到门槛的跨多课证据可以写。
    const multi = await finalizeLearnerMemoryWithPolicy({
      learnerMemory: repo,
      candidates: [
        candidate({
          source: { type: 'behavioral', independentCourseCount: MULTI_COURSE_EVIDENCE_THRESHOLD },
        }),
      ],
    });
    expect(multi[0]?.decision).toBe('write');
    expect((await repo.load())?.entries[0]?.sourceType).toBe('multi_course_evidence');
  });

  it('does not silently overwrite a stable preference on conflict', () => {
    const existing: LearnerMemoryEntry = {
      schemaVersion: 1,
      id: 'learner-entry:stable',
      dimension: 'pace',
      value: '直接讲重点',
      sourceType: 'explicit_longterm',
      supportingCourseCount: 3,
      confidence: 0.9,
      observedAt: NOW,
      updatedAt: NOW,
    };
    // 单次矛盾行为：保留既有稳定偏好。
    const [weak] = evaluateCandidates(
      [
        candidate({
          value: '慢一点',
          source: { type: 'behavioral', independentCourseCount: 2 },
        }),
      ],
      [existing],
    );
    expect(weak?.decision).toBe('conflict-kept');
    const kept = applyPolicyDecisions(
      {
        ...createEmptyLearnerMemory({ stageId: STAGE, learnerId: LEARNER_A, now: NOW }),
        entries: [existing],
      },
      [weak!],
      LATER,
    );
    expect(kept.entries).toEqual([existing]);

    // 明确长期表达可以替换（学习者明确改主意）。
    const [strong] = evaluateCandidates([candidate({ value: '慢一点' })], [existing]);
    expect(strong?.decision).toBe('write');
    const replaced = applyPolicyDecisions(
      {
        ...createEmptyLearnerMemory({ stageId: STAGE, learnerId: LEARNER_A, now: NOW }),
        entries: [existing],
      },
      [strong!],
      LATER,
    );
    expect(replaced.entries).toHaveLength(1);
    expect(replaced.entries[0]?.value).toBe('慢一点');
  });

  it('is idempotent across finalize retries', async () => {
    const s = store(`policy-retry-${crypto.randomUUID()}`);
    const repo = createLearnerMemoryRepository({
      store: s,
      scope: { stageId: STAGE, learnerId: LEARNER_A },
      now: () => NOW,
    });
    const candidates = [candidate({})];
    await finalizeLearnerMemoryWithPolicy({ learnerMemory: repo, candidates, now: () => NOW });
    const first = await repo.load();
    await finalizeLearnerMemoryWithPolicy({ learnerMemory: repo, candidates, now: () => NOW });
    const second = await repo.load();
    expect(second).toEqual(first);
    expect(second?.entries).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────
//  context：固定优先级、有上限、负向串课
// ──────────────────────────────────────────────

describe('teacher context assembly', () => {
  const learner: ReturnType<typeof createEmptyLearnerMemory> = {
    ...createEmptyLearnerMemory({ stageId: STAGE, learnerId: LEARNER_A, now: NOW }),
    entries: [
      {
        schemaVersion: 1,
        id: 'learner-entry:pace',
        dimension: 'pace',
        value: '偏好慢一点',
        sourceType: 'explicit_longterm',
        supportingCourseCount: 1,
        confidence: 0.9,
        observedAt: NOW,
        updatedAt: NOW,
      },
    ],
  };

  it('orders blocks explicit > working > course > learner > defaults', () => {
    const context = buildTeacherContext({
      mode: 'in-class',
      explicit: [{ label: '本次', value: '想先听例子' }],
      workingMemory: {
        schemaVersion: 1,
        classroomSessionId: 'session-1',
        stageId: STAGE,
        learnerId: LEARNER_A,
        courseId: COURSE_A,
        lessonId: 'lesson-1',
        currentNodeId: 'node:2',
        resumeNodeId: null,
        interruptions: [],
        currentAnswer: null,
        transientAdjustments: [],
        shortSummary: '',
        updatedAt: NOW,
      },
      courseMemory: {
        stageId: STAGE,
        learnerId: LEARNER_A,
        courseId: COURSE_A,
        misconceptions: [],
        unresolvedQuestions: [],
        evidenceTailRevision: 0,
        goalStates: [],
        evidence: [],
        intake: {
          requirement: '需求 A',
          preClassAnswers: [],
          finalScope: [],
          skipped: false,
          submittedAt: NOW,
        },
      },
      learnerMemory: learner,
      defaults: [{ label: '默认', value: '标准节奏' }],
    });
    const sources = context.blocks.map((block) => block.source);
    expect(sources).toEqual(['explicit', 'working', 'course', 'learner', 'defaults']);
  });

  it('new-course mode reads only L — no other course content can enter (负向串课)', () => {
    const courseMemoryA: CourseLearningMemory = {
      stageId: STAGE,
      learnerId: LEARNER_A,
      courseId: COURSE_A,
      misconceptions: [
        { id: 'm1', note: '误以为 var 是块级作用域', evidenceIds: [], recordedAt: NOW },
      ],
      unresolvedQuestions: [
        { id: 'q1', question: '闭包到底是什么？', sourceSessionId: 's1', archivedAt: NOW },
      ],
      evidenceTailRevision: 3,
      goalStates: [],
      evidence: [makeEvidence({ id: 'ev-a1', courseId: COURSE_A, learnerId: LEARNER_A })],
      intake: {
        requirement: '学 JavaScript 闭包',
        preClassAnswers: [],
        finalScope: ['闭包'],
        skipped: false,
        submittedAt: NOW,
      },
    };

    const context = buildTeacherContext({
      mode: 'new-course',
      courseMemory: courseMemoryA,
      learnerMemory: learner,
    });

    // 新课上下文只有 L；course-a 的课程内容、误解、未解决问题、证据全部缺席。
    expect(context.blocks.map((block) => block.source)).toEqual(['learner']);
    expect(context.text).toContain('偏好慢一点');
    expect(context.text).not.toContain('闭包');
    expect(context.text).not.toContain('var');
    expect(context.text).not.toContain(COURSE_A);
  });

  it('resume-same-course reads C + L but never old session temp state', () => {
    const context = buildTeacherContext({
      mode: 'resume-same-course',
      workingMemory: {
        schemaVersion: 1,
        classroomSessionId: 'old-session',
        stageId: STAGE,
        learnerId: LEARNER_A,
        courseId: COURSE_A,
        lessonId: 'lesson-1',
        currentNodeId: 'node:9',
        resumeNodeId: 'node:9',
        interruptions: [],
        currentAnswer: null,
        transientAdjustments: [],
        shortSummary: '旧 session 的临时摘要',
        updatedAt: NOW,
      },
      courseMemory: {
        stageId: STAGE,
        learnerId: LEARNER_A,
        courseId: COURSE_A,
        misconceptions: [],
        unresolvedQuestions: [],
        evidenceTailRevision: 0,
        goalStates: [],
        evidence: [],
        progress: { completedNodeIds: ['node:1'], updatedAt: NOW },
      },
      learnerMemory: learner,
    });
    const sources = context.blocks.map((block) => block.source);
    expect(sources).toEqual(['course', 'learner']);
    expect(context.text).not.toContain('旧 session');
    expect(context.text).not.toContain('node:9');
  });

  it('re-validates L entries through the whitelist schema before injection', () => {
    const corrupt = {
      schemaVersion: 1,
      id: 'bad',
      dimension: 'mastery', // 非白名单维度
      value: 'advanced',
      sourceType: 'explicit_longterm',
      supportingCourseCount: 1,
      confidence: 0.5,
      observedAt: NOW,
      updatedAt: NOW,
    } as unknown as LearnerMemoryEntry;
    expect(filterInjectibleLearnerEntries([corrupt, ...learner.entries])).toEqual(learner.entries);
  });

  it('bounds the total context size', () => {
    const context = buildTeacherContext({
      mode: 'new-course',
      learnerMemory: {
        ...learner,
        entries: Array.from({ length: 32 }, (_, index) => ({
          schemaVersion: 1 as const,
          id: `e${index}`,
          dimension: 'stable_constraint' as const,
          value: `约束${index}${'长'.repeat(150)}`,
          sourceType: 'multi_course_evidence' as const,
          supportingCourseCount: 2,
          confidence: 0.7,
          observedAt: NOW,
          updatedAt: NOW,
        })),
      },
    });
    expect(context.text.length).toBeLessThanOrEqual(MAX_TOTAL_CONTEXT_CHARS);
  });
});
