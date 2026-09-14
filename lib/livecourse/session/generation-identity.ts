/**
 * Stable identity allocation for a generation attempt.
 *
 * The browser preview and the server one-shot worker use the same pure
 * contract. A caller supplies the immutable seed (browser session id or
 * durable job id); retries reuse it and therefore cannot mint a second
 * course/stage/lesson tuple.
 */

export interface GenerationIdentity {
  courseId: string;
  stageId: string;
  lessonId: string;
}

export class GenerationIdentityError extends Error {
  override readonly name = 'GenerationIdentityError';
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GenerationIdentityError(`A generation identity requires a non-empty ${field}`);
  }
  return value.trim();
}

function persistedValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

export function createGenerationIdentity(seed: string): GenerationIdentity {
  const normalized = requireNonEmpty(seed, 'seed');
  return {
    courseId: `course-${normalized}`,
    stageId: `stage-${normalized}`,
    lessonId: `lesson-${normalized}`,
  };
}

export function resolveGenerationIdentity(input: {
  sessionId: string;
  courseId?: unknown;
  stageId?: unknown;
  lessonId?: unknown;
}): GenerationIdentity {
  // `sessionId` is the durable retry key.  Do not let an invalid/missing
  // session silently mint a fresh identity from a fallback value.
  const sessionId = requireNonEmpty(input.sessionId, 'sessionId');
  const fallback = createGenerationIdentity(sessionId);
  return {
    courseId: persistedValue(input.courseId, fallback.courseId),
    stageId: persistedValue(input.stageId, fallback.stageId),
    lessonId: persistedValue(input.lessonId, fallback.lessonId),
  };
}

export function withGenerationIdentity<
  T extends { sessionId: string } & Partial<GenerationIdentity>,
>(session: T): T & GenerationIdentity {
  return { ...session, ...resolveGenerationIdentity(session) };
}
