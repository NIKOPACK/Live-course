/**
 * Compatibility boundary for the optional course-plan document metadata.
 * This intentionally does not import the application domain package: the
 * storage package must remain usable by browser, server and HTTP clients.
 * The application schema performs the complete domain validation; this layer
 * only protects the persistence/version boundary and never silently drops data.
 */

export const COURSE_PLAN_SCHEMA_VERSION = 1 as const;

export class CoursePlanMigrationError extends Error {
  override readonly name = 'CoursePlanMigrationError';

  constructor(
    readonly stageId: string,
    readonly reason: 'malformed' | 'unsupported' | 'missing-version',
    readonly storedVersion: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function planVersion(value: Record<string, unknown>): number | undefined {
  const version = value.version;
  return typeof version === 'number' && Number.isInteger(version) && version > 0
    ? version
    : undefined;
}

/** Minimum storage shape; semantic validation remains in the app domain schema. */
function hasCoursePlanShape(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === 'string' &&
    typeof value.courseId === 'string' &&
    typeof value.title === 'string' &&
    Array.isArray(value.goals) &&
    Array.isArray(value.lessons) &&
    Array.isArray(value.checkpointRules)
  );
}

function malformed(stageId: string, message: string): CoursePlanMigrationError {
  return new CoursePlanMigrationError(stageId, 'malformed', undefined, message);
}

/** Validate metadata on a new write. Unversioned writes are never accepted. */
export function assertWritableCoursePlan(value: unknown, stageId: string): void {
  const plan = objectValue(value);
  if (!plan)
    throw malformed(stageId, `course plan for ${JSON.stringify(stageId)} must be an object`);
  if (plan.schemaVersion !== COURSE_PLAN_SCHEMA_VERSION) {
    const reason = plan.schemaVersion === undefined ? 'missing-version' : 'unsupported';
    throw new CoursePlanMigrationError(
      stageId,
      reason,
      typeof plan.schemaVersion === 'number' ? plan.schemaVersion : undefined,
      `@livecourse/storage: refusing to save course plan for ${JSON.stringify(stageId)} — ` +
        `course plan schemaVersion must be ${COURSE_PLAN_SCHEMA_VERSION}`,
    );
  }
  if (planVersion(plan) === undefined) {
    throw malformed(
      stageId,
      `@livecourse/storage: refusing to save course plan for ${JSON.stringify(stageId)} — ` +
        'course plan version must be a positive integer',
    );
  }
  if (!hasCoursePlanShape(plan)) {
    throw malformed(
      stageId,
      `@livecourse/storage: refusing to save malformed course plan for ${JSON.stringify(stageId)}`,
    );
  }
}

/**
 * Read compatibility for the metadata line. Version 0 was the short-lived
 * browser classroom shape: it had the current fields but no schemaVersion.
 * Reads may stamp that known shape; writes must still reject it so callers
 * cannot accidentally create more unversioned records.
 */
export function migrateCoursePlan(value: unknown, stageId: string): unknown {
  if (value === undefined) return undefined;
  const plan = objectValue(value);
  if (!plan)
    throw malformed(stageId, `course plan for ${JSON.stringify(stageId)} must be an object`);

  if (plan.schemaVersion === undefined) {
    if (planVersion(plan) === undefined) {
      throw new CoursePlanMigrationError(
        stageId,
        'missing-version',
        undefined,
        `@livecourse/storage: no migration path for unversioned course plan in ${JSON.stringify(stageId)}`,
      );
    }
    if (!hasCoursePlanShape(plan)) {
      throw new CoursePlanMigrationError(
        stageId,
        'malformed',
        undefined,
        `@livecourse/storage: course plan in ${JSON.stringify(stageId)} is malformed`,
      );
    }
    return { ...plan, schemaVersion: COURSE_PLAN_SCHEMA_VERSION };
  }
  if (plan.schemaVersion !== COURSE_PLAN_SCHEMA_VERSION) {
    throw new CoursePlanMigrationError(
      stageId,
      'unsupported',
      typeof plan.schemaVersion === 'number' ? plan.schemaVersion : undefined,
      `@livecourse/storage: no migration path for course plan schemaVersion ` +
        `${JSON.stringify(plan.schemaVersion)} in ${JSON.stringify(stageId)}`,
    );
  }
  if (planVersion(plan) === undefined) {
    throw malformed(
      stageId,
      `@livecourse/storage: course plan in ${JSON.stringify(stageId)} has no positive version`,
    );
  }
  if (!hasCoursePlanShape(plan)) {
    throw malformed(
      stageId,
      `@livecourse/storage: course plan in ${JSON.stringify(stageId)} is malformed`,
    );
  }
  return { ...plan };
}

export function assertReadableCoursePlan(value: unknown, stageId: string): void {
  // Use the same migration path for a detached metadata row as for an embedded
  // legacy row. The return value is deliberately ignored by this assertion.
  migrateCoursePlan(value, stageId);
}
