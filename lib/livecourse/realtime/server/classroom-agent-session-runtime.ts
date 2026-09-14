/**
 * LiveCourse — server composition for the ClassroomAgentSession runtime
 * (P-007). This is the only place the session service is wired to the
 * application's classroom document store: the browser can never declare the
 * course plan, lesson scope, teacher agent or assistant roster.
 */
import { readClassroom } from '@/lib/server/classroom-storage';
import { coursePlanSchema, type CoursePlan } from '@/lib/livecourse/domain';
import {
  ClassroomAgentSessionError,
  ClassroomAgentSessionService,
  deriveClassroomAgents,
  deriveCoursePlanFromClassroomShape,
  InMemoryClassroomAgentSessionStore,
  selectUniqueLessonForStage,
  type ClassroomShapeScene,
} from './classroom-agent-session';
import { unavailableAssistantExecutor } from './unavailable-assistant-executor';

const CLASSROOM_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function requireClassroomId(value: string): string {
  const normalized = value?.trim();
  if (!normalized || !CLASSROOM_ID_PATTERN.test(normalized)) {
    throw new ClassroomAgentSessionError(
      'INVALID_CLASSROOM_ID',
      'classroom id must contain only letters, digits, dash or underscore',
      400,
    );
  }
  return normalized;
}

let runtime: ClassroomAgentSessionService | undefined;
let clock: (() => string) | undefined;

/** Injected clock for hermetic tests; production uses the real wall clock. */
export function configureAgentSessionClock(next: () => string): void {
  clock = next;
  runtime = undefined;
}

/** Inject a custom service (used by tests); `undefined` resets to the default. */
export function configureClassroomAgentSessionService(next?: ClassroomAgentSessionService): void {
  runtime = next;
}

/** Reset the singleton (used by tests between cases). */
export function resetClassroomAgentSessionRuntime(): void {
  runtime = undefined;
  clock = undefined;
}

/**
 * Resolve a classroom's executable plan at the server boundary.  The route
 * parameter is a stage id; a persisted CoursePlan, when present, is
 * authoritative and must pass the application schema before it can be used.
 * Documents without a plan retain the legacy scene-derived behavior.
 */
export async function resolveClassroomCoursePlan(stageIdInput: string): Promise<CoursePlan> {
  const stageId = requireClassroomId(stageIdInput);
  const classroom = await readClassroom(stageId);
  if (!classroom) {
    throw new ClassroomAgentSessionError(
      'CLASSROOM_NOT_FOUND',
      'classroom is not available in the server classroom store',
      404,
    );
  }

  if (classroom.coursePlan !== undefined) {
    const coursePlan = coursePlanSchema.parse(classroom.coursePlan);
    // Keep the stage/lesson invariant explicit even though the current plan
    // schema also rejects duplicate lesson stage ids.
    selectUniqueLessonForStage(coursePlan, stageId);
    return coursePlan;
  }

  const scenes: ClassroomShapeScene[] = classroom.scenes.map((scene) => ({
    id: scene.id,
    title: scene.title,
    order: scene.order,
    type: scene.type,
  }));
  return deriveCoursePlanFromClassroomShape({
    // Legacy classrooms have no independent course identity; bind both
    // identities to the route stage rather than borrowing a document field.
    courseId: stageId,
    stageId,
    stageTitle: classroom.stage.name,
    scenes,
  });
}

export function getClassroomAgentSessionService(): ClassroomAgentSessionService {
  runtime ??= new ClassroomAgentSessionService({
    store: new InMemoryClassroomAgentSessionStore(),
    executor: unavailableAssistantExecutor,
    clock: clock ?? (() => new Date().toISOString()),
    resolveCoursePlan: ({ stageId }) => resolveClassroomCoursePlan(stageId),
    resolveClassroomAgents: deriveClassroomAgents,
  });
  return runtime;
}
