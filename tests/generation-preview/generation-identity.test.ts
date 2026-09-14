import { describe, expect, it } from 'vitest';

import {
  createGenerationIdentity,
  GenerationIdentityError,
  resolveGenerationIdentity,
  withGenerationIdentity,
} from '@/app/generation-preview/types';

describe('generation identity', () => {
  it('allocates distinct, deterministic course/stage/lesson ids from one session id', () => {
    const first = createGenerationIdentity('session-123');
    const second = createGenerationIdentity('session-123');

    expect(first).toEqual(second);
    expect(first).toEqual({
      courseId: 'course-session-123',
      stageId: 'stage-session-123',
      lessonId: 'lesson-session-123',
    });
    expect(new Set(Object.values(first)).size).toBe(3);
  });

  it('derives all missing fields independently for a legacy session', () => {
    expect(resolveGenerationIdentity({ sessionId: 'legacy-1' })).toEqual({
      courseId: 'course-legacy-1',
      stageId: 'stage-legacy-1',
      lessonId: 'lesson-legacy-1',
    });
    expect(
      resolveGenerationIdentity({
        sessionId: 'legacy-1',
        courseId: 'persisted-course',
      }),
    ).toEqual({
      courseId: 'persisted-course',
      stageId: 'stage-legacy-1',
      lessonId: 'lesson-legacy-1',
    });
  });

  it('repairs a session without mutating its original object', () => {
    const original = { sessionId: 'legacy-2', requirements: { requirement: 'x' } };
    const repaired = withGenerationIdentity(original);

    expect(repaired).toMatchObject({
      sessionId: 'legacy-2',
      courseId: 'course-legacy-2',
      stageId: 'stage-legacy-2',
      lessonId: 'lesson-legacy-2',
    });
    expect(original).toEqual({ sessionId: 'legacy-2', requirements: { requirement: 'x' } });
  });

  it('fails closed when the session id is missing or blank', () => {
    expect(() => createGenerationIdentity('')).toThrow(GenerationIdentityError);
    expect(() => resolveGenerationIdentity({ sessionId: '   ' })).toThrow(/non-empty sessionId/i);
  });
});
