const FORBIDDEN_KEYS = new Set([
  'learnerId',
  'progress',
  'playbackPosition',
  'lifecycle',
  'evidence',
  'evidenceIds',
  'goalState',
  'GoalState',
  'intake',
  'unresolvedQuestions',
  'courseMisconceptions',
  'misconceptions',
  'teachingActions',
  'assistantTasks',
  'adjustments',
  'generationSession',
  'apiKey',
  'accessToken',
  'workingMemory',
  'sessionId',
  'classroomSessionId',
]);

function keepMisconceptions(path: readonly string[], key: string): boolean {
  return key === 'misconceptions' && path.includes('design');
}

function stripValue(value: unknown, path: readonly string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => stripValue(item, [...path, String(index)]));
  }
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key) && !keepMisconceptions(path, key)) continue;
      next[key] = stripValue(child, [...path, key]);
    }
    return next;
  }
  return value;
}

/** Drop learning-instance fields. Keep lesson-plan design.misconceptions (materials). */
export function stripShareMaterials<T>(value: T): T {
  return stripValue(value, []) as T;
}
