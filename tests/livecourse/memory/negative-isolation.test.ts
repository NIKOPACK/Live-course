import 'fake-indexeddb/auto';

import { BrowserRuntimeStore, type RuntimeStore } from '@livecourse/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/web-search/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/web-search/constants')>();
  const fallback = {
    id: 'mock',
    name: 'mock',
    requiresApiKey: false,
    defaultBaseUrl: '',
    endpointPath: '/',
    icon: '',
  };
  return {
    ...actual,
    WEB_SEARCH_PROVIDERS: new Proxy(actual.WEB_SEARCH_PROVIDERS, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return { ...fallback, id: String(prop) };
      },
    }),
  };
});

import type { EvidenceRecord, GoalState } from '@/lib/livecourse/domain';
import { appendEvidenceRecord } from '@/lib/livecourse/evidence/runtime-repository';
import {
  COURSE_MEMORY_KIND,
  LEARNER_MEMORY_KIND,
  WORKING_MEMORY_KIND,
  buildTeacherContext,
  createCourseMemoryRepository,
  createLearnerMemoryRepository,
  createWorkingMemoryRepository,
  finalizeSessionLearnerMemory,
  loadCourseLearningMemory,
  loadNewCourseMemoryContext,
  MissingCourseIdError,
  persistGenerationCourseIntake,
} from '@/lib/livecourse/memory';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { storeDocumentBlob, storeImages } from '@/lib/utils/image-storage';

const NOW = '2026-09-14T12:00:00.000Z';
const MEMORY_KINDS = new Set([WORKING_MEMORY_KIND, COURSE_MEMORY_KIND, LEARNER_MEMORY_KIND]);

function instrument(inner: RuntimeStore) {
  const createdKinds: string[] = [];
  const store: RuntimeStore = {
    createSession: async (init) => {
      createdKinds.push(init.kind);
      return inner.createSession(init);
    },
    getSession: (id) => inner.getSession(id),
    listSessions: (stageId, learnerKey) => inner.listSessions(stageId, learnerKey),
    setSessionStatus: (id, status, updatedAt, options) =>
      inner.setSessionStatus(id, status, updatedAt, options),
    deleteSession: (id) => inner.deleteSession(id),
    appendRecord: (init, options) => inner.appendRecord(init, options),
    listRecords: (id, opts) => inner.listRecords(id, opts),
    mergeLearner: (from, to) => inner.mergeLearner(from, to),
    deleteLearnerRuntime: (stageId, learnerKey) => inner.deleteLearnerRuntime(stageId, learnerKey),
    deleteStageRuntime: (stageId) => inner.deleteStageRuntime(stageId),
    deleteAllRuntime: () => inner.deleteAllRuntime(),
  };
  return { store, createdKinds };
}

describe('settings, drafts and uploads do not write W / C / L (A6)', () => {
  let backing: Map<string, string>;
  let failWrites = false;
  const localStorageStub: Storage = {
    get length() {
      return backing.size;
    },
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => {
      if (failWrites) throw new Error('storage quota exhausted');
      backing.set(key, value);
    },
    removeItem: (key) => void backing.delete(key),
    clear: () => backing.clear(),
    key: (index) => [...backing.keys()][index] ?? null,
  };

  beforeEach(() => {
    backing = new Map();
    failWrites = false;
    vi.stubGlobal('localStorage', localStorageStub);
    vi.stubGlobal('sessionStorage', localStorageStub);
    vi.stubGlobal('window', { localStorage: localStorageStub, sessionStorage: localStorageStub });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not create learning-memory sessions when settings save or retry', async () => {
    const { configureRuntimeStorage, resetRuntimeStorageForTests } =
      await import('@/lib/runtime/store');
    resetRuntimeStorageForTests();
    const { store, createdKinds } = instrument(
      new BrowserRuntimeStore({
        dbName: `memory-settings-${crypto.randomUUID()}`,
        payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
      }),
    );
    configureRuntimeStorage({ store });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { useSettingsStore, saveSettings } = await import('@/lib/store/settings');
    await useSettingsStore.persist.rehydrate();

    await saveSettings((state) => state.setPlaybackSpeed(1.25));
    expect(createdKinds.filter((kind) => MEMORY_KINDS.has(kind))).toEqual([]);

    failWrites = true;
    await expect(saveSettings((state) => state.setPlaybackSpeed(1.5))).rejects.toThrow(
      /Could not persist/,
    );
    expect(createdKinds.filter((kind) => MEMORY_KINDS.has(kind))).toEqual([]);
  });

  it('keeps homepage drafts and upload blobs out of W / C / L', async () => {
    const { configureRuntimeStorage, resetRuntimeStorageForTests } =
      await import('@/lib/runtime/store');
    resetRuntimeStorageForTests();
    const { store, createdKinds } = instrument(
      new BrowserRuntimeStore({
        dbName: `memory-draft-${crypto.randomUUID()}`,
        payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
      }),
    );
    configureRuntimeStorage({ store });

    localStorageStub.setItem('requirementDraft', JSON.stringify('我想学高数'));
    localStorageStub.setItem(
      'generationSession',
      JSON.stringify({ requirements: { requirement: '我想学高数' } }),
    );
    const key = await storeDocumentBlob(
      new File([new Uint8Array([1, 2, 3])], 'notes.pdf', { type: 'application/pdf' }),
    );
    expect(key.startsWith('pdf_')).toBe(true);
    const imageIds = await storeImages([
      {
        id: 'img_media_load',
        src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        pageNumber: 1,
      },
    ]);
    expect(imageIds).toHaveLength(1);
    expect(createdKinds.filter((kind) => MEMORY_KINDS.has(kind))).toEqual([]);

    await persistGenerationCourseIntake({
      store,
      stageId: 'stage-new',
      learnerId: 'learner-new',
      courseId: 'course-new',
      intake: {
        requirement: '我想学高数',
        preClassAnswers: [],
        finalScope: ['我想学高数'],
        skipped: true,
        submittedAt: NOW,
      },
      now: () => NOW,
    });
    expect(createdKinds.filter((kind) => MEMORY_KINDS.has(kind))).toEqual([COURSE_MEMORY_KIND]);
    expect(createdKinds).not.toContain(LEARNER_MEMORY_KIND);
    expect(createdKinds).not.toContain(WORKING_MEMORY_KIND);
  });
});

const FIXTURE_NOW = '2026-09-14T12:00:00.000Z';
const STAGE_FIXTURE = 'stage-two-course';
const LEARNER_ONE = 'learner-one';
const LEARNER_TWO = 'learner-two';
const COURSE_CALC = 'course-calculus';
const COURSE_HIST = 'course-history';
const OLD_SESSION = 'classroom-session-calculus-old';

/** Tokens that must never appear in a new-course prompt / generation input. */
const PREVIOUS_COURSE_LEAK_TOKENS = [
  '微积分入门',
  'LessonPlan:链式法则讲授设计',
  '知识点-导数定义',
  'quiz:下列哪项是导数',
  '作答:极限定义',
  '分数0.17',
  '已掌握链式法则',
  '本课摘要:讲完了极限',
  '学生说:老师刚才那句我没听懂',
  '本主题程度:考研',
  COURSE_CALC,
] as const;

function fixtureStore(): BrowserRuntimeStore {
  return new BrowserRuntimeStore({
    dbName: `memory-two-course-${crypto.randomUUID()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
}

function leakEvidence(learnerId: string, courseId: string): EvidenceRecord {
  return {
    schemaVersion: 1,
    id: `ev-${courseId}`,
    courseId,
    lessonId: 'lesson-1',
    learnerId,
    goalId: 'goal:chain-rule',
    nodeId: 'node-quiz-1',
    source: 'checkpoint',
    kind: 'objective_score',
    status: 'accepted',
    score: 0.91,
    occurredAt: FIXTURE_NOW,
    idempotencyKey: `key:${courseId}:${learnerId}`,
    evaluation: { method: 'deterministic', ruleVersion: 'rule:v1' },
  };
}

function leakGoal(learnerId: string, courseId: string): GoalState {
  return {
    schemaVersion: 1,
    courseId,
    learnerId,
    goalId: 'goal:chain-rule',
    ruleVersion: 'rule:v1',
    status: 'met',
    evidenceIds: [`ev-${courseId}`],
    acceptedEvidenceCount: 1,
    pendingReviewCount: 0,
    passingEvidenceCount: 1,
    latestScore: 0.91,
    averageScore: 0.91,
    updatedAt: FIXTURE_NOW,
  };
}

describe('A6 two-course fixture: reopen, new-course L-only, negative leak', () => {
  it('restores same-course C+L, reads only L for a new course, and keeps previous-course content out of generation input', async () => {
    const store = fixtureStore();
    const courseCalc = createCourseMemoryRepository({
      store,
      scope: { stageId: STAGE_FIXTURE, learnerId: LEARNER_ONE, courseId: COURSE_CALC },
      now: () => FIXTURE_NOW,
    });
    const learnerMemory = createLearnerMemoryRepository({
      store,
      scope: { learnerId: LEARNER_ONE },
      now: () => FIXTURE_NOW,
    });
    const working = createWorkingMemoryRepository({
      store,
      scope: {
        stageId: STAGE_FIXTURE,
        learnerId: LEARNER_ONE,
        classroomSessionId: OLD_SESSION,
        courseId: COURSE_CALC,
        lessonId: 'lesson-1',
      },
      now: () => FIXTURE_NOW,
    });

    await persistGenerationCourseIntake({
      store,
      stageId: STAGE_FIXTURE,
      learnerId: LEARNER_ONE,
      courseId: COURSE_CALC,
      intake: {
        requirement: '微积分入门 LessonPlan:链式法则讲授设计',
        preClassAnswers: [
          {
            questionId: 'q-level',
            answer: '本主题程度:考研',
            answeredAt: FIXTURE_NOW,
          },
        ],
        finalScope: ['知识点-导数定义'],
        skipped: false,
        submittedAt: FIXTURE_NOW,
      },
      now: () => FIXTURE_NOW,
    });
    await appendEvidenceRecord(STAGE_FIXTURE, leakEvidence(LEARNER_ONE, COURSE_CALC), {
      store,
      learnerId: LEARNER_ONE,
      courseId: COURSE_CALC,
    });
    const workingSnapshot = await working.update((current) => ({
      ...current,
      currentNodeId: 'node-chain',
      shortSummary: '本课摘要:讲完了极限',
      interruptions: [
        {
          id: 'interrupt-raw',
          question: '学生说:老师刚才那句我没听懂',
          resumeNodeId: 'node-intro',
          status: 'open',
          occurredAt: FIXTURE_NOW,
        },
      ],
    }));
    await finalizeSessionLearnerMemory({
      learnerMemory,
      courseMemory: courseCalc,
      workingMemory: workingSnapshot,
      intake: {
        requirement: '我通常喜欢用图示学新课，一直以来都希望慢一点',
        preClassAnswers: [],
        finalScope: ['知识点-导数定义'],
        skipped: false,
        submittedAt: FIXTURE_NOW,
      },
      goalStates: [
        leakGoal(LEARNER_ONE, COURSE_CALC),
        {
          ...leakGoal(LEARNER_ONE, COURSE_CALC),
          goalId: 'goal:limit',
          status: 'needs_support',
          passingEvidenceCount: 0,
          latestScore: 0.17,
          averageScore: 0.17,
          evidenceIds: ['ev-support-limit'],
        },
      ],
      now: () => FIXTURE_NOW,
    });

    await courseCalc.update((current) => ({
      ...current,
      misconceptions: [
        ...current.misconceptions,
        {
          id: 'misconception-quiz',
          note: 'quiz:下列哪项是导数 作答:极限定义 分数0.17 已掌握链式法则',
          evidenceIds: [`ev-${COURSE_CALC}`],
          recordedAt: FIXTURE_NOW,
        },
      ],
    }));
    await working.destroy();

    expect(await working.load()).toBeUndefined();
    expect(() =>
      createCourseMemoryRepository({
        store,
        scope: { stageId: STAGE_FIXTURE, learnerId: LEARNER_ONE, courseId: '' },
      }),
    ).toThrow(MissingCourseIdError);

    const resumed = await loadCourseLearningMemory({
      store,
      scope: { stageId: STAGE_FIXTURE, learnerId: LEARNER_ONE, courseId: COURSE_CALC },
      courseState: {
        load: async () =>
          ({
            progress: {
              completedNodeIds: ['node-intro', 'node-chain'],
              lastCompletedNodeId: 'node-chain',
              updatedAt: FIXTURE_NOW,
            },
          }) as never,
      },
      goalRules: {
        'goal:chain-rule': {
          version: 'rule:v1',
          passScore: 0.7,
          minAcceptedEvidence: 1,
          minPassingEvidence: 1,
        },
      },
    });
    const storedLearner = await learnerMemory.load();
    const resumeContext = buildTeacherContext({
      mode: 'resume-same-course',
      workingMemory: workingSnapshot,
      courseMemory: resumed,
      learnerMemory: storedLearner,
    });

    expect(resumed.progress?.completedNodeIds).toEqual(['node-intro', 'node-chain']);
    expect(resumed.evidence.map((item) => item.id)).toEqual([`ev-${COURSE_CALC}`]);
    expect(resumed.unresolvedQuestions.map((item) => item.question)).toEqual([
      '学生说:老师刚才那句我没听懂',
    ]);
    expect(resumed.misconceptions.some((item) => item.note.includes('quiz:下列哪项是导数'))).toBe(
      true,
    );
    expect(
      new Set(storedLearner?.entries.map((entry) => `${entry.dimension}:${entry.value}`)),
    ).toEqual(new Set(['pace:慢一点', 'teaching_method:偏好图示']));
    expect(resumeContext.blocks.map((block) => block.source)).toEqual(['course', 'learner']);
    expect(resumeContext.text).toContain('偏好图示');
    expect(resumeContext.text).toContain('慢一点');
    expect(resumeContext.text).toContain('学生说:老师刚才那句我没听懂');
    expect(resumeContext.text).toContain('Completed nodes: 2');
    expect(resumeContext.text).toContain('Goal goal:chain-rule: 会');
    expect(resumeContext.text).not.toContain('本课摘要:讲完了极限');

    const newCourse = await loadNewCourseMemoryContext({
      store,
      stageId: STAGE_FIXTURE,
      learnerId: LEARNER_ONE,
      requirements: { requirement: '我想学中国近代史' },
    });
    const generationInput = {
      requirement: '我想学中国近代史',
      teacherContext: newCourse.teacherContext.text,
    };
    expect(newCourse.teacherContext.blocks.map((block) => block.source)).toEqual(['learner']);
    expect(newCourse.teacherContext.text).toContain('偏好图示');
    expect(newCourse.teacherContext.text).toContain('慢一点');
    expect(newCourse.learnerMemory?.entries.some((entry) => entry.dimension === 'pace')).toBe(true);
    for (const token of PREVIOUS_COURSE_LEAK_TOKENS) {
      expect(generationInput.teacherContext).not.toContain(token);
      expect(JSON.stringify(generationInput)).not.toContain(token);
      expect(JSON.stringify(newCourse.learnerMemory)).not.toContain(token);
    }
    expect(generationInput.teacherContext).not.toContain('本主题程度');
    expect(
      await createCourseMemoryRepository({
        store,
        scope: { stageId: STAGE_FIXTURE, learnerId: LEARNER_ONE, courseId: COURSE_HIST },
      }).load(),
    ).toBeUndefined();
  });

  it('isolates W / C / L across two learnerIds and two courseIds', async () => {
    const store = fixtureStore();
    const scopes = [
      { learnerId: LEARNER_ONE, courseId: COURSE_CALC, sessionId: 'session-one-calc' },
      { learnerId: LEARNER_ONE, courseId: COURSE_HIST, sessionId: 'session-one-hist' },
      { learnerId: LEARNER_TWO, courseId: COURSE_CALC, sessionId: 'session-two-calc' },
      { learnerId: LEARNER_TWO, courseId: COURSE_HIST, sessionId: 'session-two-hist' },
    ] as const;

    for (const scope of scopes) {
      await persistGenerationCourseIntake({
        store,
        stageId: STAGE_FIXTURE,
        learnerId: scope.learnerId,
        courseId: scope.courseId,
        intake: {
          requirement: `${scope.learnerId}:${scope.courseId}`,
          preClassAnswers: [],
          finalScope: [`${scope.learnerId}:${scope.courseId}`],
          skipped: true,
          submittedAt: FIXTURE_NOW,
        },
        now: () => FIXTURE_NOW,
      });
      await createWorkingMemoryRepository({
        store,
        scope: {
          stageId: STAGE_FIXTURE,
          learnerId: scope.learnerId,
          classroomSessionId: scope.sessionId,
          courseId: scope.courseId,
          lessonId: 'lesson-1',
        },
        now: () => FIXTURE_NOW,
      }).update((current) => ({
        ...current,
        shortSummary: `W:${scope.learnerId}:${scope.sessionId}`,
      }));
    }
    await createLearnerMemoryRepository({
      store,
      scope: { learnerId: LEARNER_ONE },
      now: () => FIXTURE_NOW,
    }).update((current) => ({
      ...current,
      entries: [
        {
          schemaVersion: 1,
          id: 'learner-entry:one',
          dimension: 'pace',
          value: '慢一点',
          sourceType: 'explicit_longterm',
          supportingCourseCount: 1,
          confidence: 0.9,
          observedAt: FIXTURE_NOW,
          updatedAt: FIXTURE_NOW,
        },
      ],
    }));
    await createLearnerMemoryRepository({
      store,
      scope: { learnerId: LEARNER_TWO },
      now: () => FIXTURE_NOW,
    }).update((current) => ({
      ...current,
      entries: [
        {
          schemaVersion: 1,
          id: 'learner-entry:two',
          dimension: 'pace',
          value: '快一点',
          sourceType: 'explicit_longterm',
          supportingCourseCount: 1,
          confidence: 0.9,
          observedAt: FIXTURE_NOW,
          updatedAt: FIXTURE_NOW,
        },
      ],
    }));

    for (const scope of scopes) {
      expect(
        (
          await createCourseMemoryRepository({
            store,
            scope: {
              stageId: STAGE_FIXTURE,
              learnerId: scope.learnerId,
              courseId: scope.courseId,
            },
          }).load()
        )?.intake?.requirement,
      ).toBe(`${scope.learnerId}:${scope.courseId}`);
      expect(
        (
          await createWorkingMemoryRepository({
            store,
            scope: {
              stageId: STAGE_FIXTURE,
              learnerId: scope.learnerId,
              classroomSessionId: scope.sessionId,
              courseId: scope.courseId,
              lessonId: 'lesson-1',
            },
          }).load()
        )?.shortSummary,
      ).toBe(`W:${scope.learnerId}:${scope.sessionId}`);
    }
    expect(
      (
        await createLearnerMemoryRepository({
          store,
          scope: { learnerId: LEARNER_ONE },
        }).load()
      )?.entries.map((entry) => entry.value),
    ).toEqual(['慢一点']);
    expect(
      (
        await createLearnerMemoryRepository({
          store,
          scope: { learnerId: LEARNER_TWO },
        }).load()
      )?.entries.map((entry) => entry.value),
    ).toEqual(['快一点']);
    expect(
      await createWorkingMemoryRepository({
        store,
        scope: {
          stageId: STAGE_FIXTURE,
          learnerId: LEARNER_TWO,
          classroomSessionId: 'session-one-calc',
          courseId: COURSE_CALC,
          lessonId: 'lesson-1',
        },
      }).load(),
    ).toBeUndefined();
  });
});
