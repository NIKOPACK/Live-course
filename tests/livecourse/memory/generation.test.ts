import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@livecourse/storage';
import { describe, expect, it } from 'vitest';

import type { ClarifyAnswer } from '@/lib/livecourse/outline/types';
import type { UserRequirements } from '@/lib/types/generation';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import {
  buildGenerationCourseIntake,
  createCourseMemoryRepository,
  createLearnerMemoryRepository,
  loadNewCourseMemoryContext,
  persistGenerationCourseIntake,
  learnerMemorySessionId,
  LEARNER_MEMORY_PARTITION_STAGE_ID,
} from '@/lib/livecourse/memory';

const NOW = '2026-08-31T00:00:00.000Z';
const LATER = '2026-08-31T01:00:00.000Z';
const STAGE = 'stage-generation';
const LEARNER = 'learner-generation';
const COURSE_A = 'course-a';
const COURSE_B = 'course-b';

function makeStore(): BrowserRuntimeStore {
  return new BrowserRuntimeStore({
    dbName: `memory-generation-${crypto.randomUUID()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
}

function requirements(overrides: Partial<UserRequirements> = {}): UserRequirements {
  return {
    requirement: '想学 Python 的异步编程',
    ...overrides,
  };
}

function answer(): ClarifyAnswer {
  return {
    questionId: 'q-level',
    question: '你的基础？',
    selectedOptionIds: ['beginner'],
    selectedLabels: ['零基础'],
  };
}

describe('generation memory boundary', () => {
  it('reads absent learner memory without creating an L session', async () => {
    const store = makeStore();

    const context = await loadNewCourseMemoryContext({
      store,
      stageId: STAGE,
      learnerId: LEARNER,
      requirements: requirements(),
    });

    expect(context.learnerMemory).toBeUndefined();
    expect(context.teacherContext.text).toBe('');
    expect(await store.getSession(learnerMemorySessionId({ learnerId: LEARNER }))).toBeUndefined();
    expect(await store.listSessions(LEARNER_MEMORY_PARTITION_STAGE_ID, LEARNER)).toEqual([]);
  });

  it('constructs a bounded C intake from answers and a selected scope', () => {
    const intake = buildGenerationCourseIntake({
      requirements: requirements({
        clarificationAnswers: [answer()],
        selectedTopics: ['  async / await  ', '', '事件循环'],
      }),
      now: NOW,
    });

    expect(intake).toEqual({
      requirement: '想学 Python 的异步编程',
      preClassAnswers: [
        {
          questionId: 'q-level',
          answer: '零基础',
          answeredAt: NOW,
        },
      ],
      finalScope: ['async / await', '事件循环'],
      skipped: false,
      submittedAt: NOW,
    });
  });

  it('uses the requirement as a bounded default scope when confirmation is skipped', () => {
    const intake = buildGenerationCourseIntake({
      requirements: requirements(),
      skipped: true,
      now: NOW,
    });

    expect(intake.skipped).toBe(true);
    expect(intake.finalScope).toEqual(['想学 Python 的异步编程']);
  });

  it('does not write C or L while assembling J1 drafts and pre-class answers', async () => {
    const store = makeStore();
    const intake = buildGenerationCourseIntake({
      requirements: requirements({
        requirement: '我通常喜欢用图示学新课',
        clarificationAnswers: [answer()],
      }),
      now: NOW,
    });
    expect(intake.preClassAnswers).toEqual([
      { questionId: 'q-level', answer: '零基础', answeredAt: NOW },
    ]);

    const context = await loadNewCourseMemoryContext({
      store,
      stageId: STAGE,
      learnerId: LEARNER,
      requirements: requirements({ requirement: '我通常喜欢用图示学新课' }),
    });

    expect(context.learnerMemory).toBeUndefined();
    expect(await store.listSessions(STAGE, LEARNER)).toEqual([]);
    expect(await store.listSessions(LEARNER_MEMORY_PARTITION_STAGE_ID, LEARNER)).toEqual([]);
    expect(
      await createCourseMemoryRepository({
        store,
        scope: { stageId: STAGE, learnerId: LEARNER, courseId: COURSE_A },
      }).load(),
    ).toBeUndefined();
  });

  it('writes only the selected course C intake and de-dupes identical retries', async () => {
    const store = makeStore();
    const intake = buildGenerationCourseIntake({
      requirements: requirements({
        requirement: '我通常喜欢用图示学新课',
        clarificationAnswers: [answer()],
      }),
      now: NOW,
    });

    const first = await persistGenerationCourseIntake({
      store,
      stageId: STAGE,
      learnerId: LEARNER,
      courseId: COURSE_A,
      intake,
      now: () => NOW,
    });
    const retryWithNewTimestamp = await persistGenerationCourseIntake({
      store,
      stageId: STAGE,
      learnerId: LEARNER,
      courseId: COURSE_A,
      intake: { ...intake, submittedAt: LATER },
      now: () => LATER,
    });

    expect(retryWithNewTimestamp).toEqual(first);
    const sessionId =
      'livecourse-course-memory:' +
      encodeURIComponent(STAGE) +
      ':' +
      encodeURIComponent(LEARNER) +
      ':' +
      encodeURIComponent(COURSE_A);
    expect((await store.listRecords(sessionId)).map((record) => record.seq)).toEqual([0]);
    expect(
      (
        await createCourseMemoryRepository({
          store,
          scope: { stageId: STAGE, learnerId: LEARNER, courseId: COURSE_A },
        }).load()
      )?.intake?.requirement,
    ).toContain('通常喜欢用图示');
    expect(
      await createCourseMemoryRepository({
        store,
        scope: { stageId: STAGE, learnerId: LEARNER, courseId: COURSE_B },
      }).load(),
    ).toBeUndefined();
    expect(
      await createLearnerMemoryRepository({
        store,
        scope: { learnerId: LEARNER },
      }).load(),
    ).toBeUndefined();
    expect(await store.listSessions(LEARNER_MEMORY_PARTITION_STAGE_ID, LEARNER)).toEqual([]);
  });

  it('does not inject course C content into a new-course learner context', async () => {
    const store = makeStore();
    await createCourseMemoryRepository({
      store,
      scope: { stageId: STAGE, learnerId: LEARNER, courseId: COURSE_A },
    }).update((current) => ({
      ...current,
      intake: buildGenerationCourseIntake({
        requirements: { requirement: '课程 A 的秘密主题' },
        now: NOW,
      }),
    }));
    await createLearnerMemoryRepository({
      store,
      scope: { stageId: STAGE, learnerId: LEARNER },
      now: () => NOW,
    }).update((current) => ({
      ...current,
      entries: [
        {
          schemaVersion: 1,
          id: 'learner-entry:pace',
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

    const context = await loadNewCourseMemoryContext({
      store,
      stageId: 'different-stage',
      learnerId: LEARNER,
    });
    expect(context.teacherContext.text).toContain('慢一点');
    expect(context.teacherContext.text).not.toContain('课程 A 的秘密主题');
  });
});
