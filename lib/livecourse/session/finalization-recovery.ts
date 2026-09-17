import type { RuntimeStore } from '@livecourse/storage';
import { LIVECOURSE_ACTION_KIND, livecourseActionSessionId } from './action-repository';
import type { CourseStateSnapshot } from './course-state-snapshot';
import {
  assertMemorySessionIdentity,
  workingMemorySessionId,
  WORKING_MEMORY_KIND,
} from '@/lib/livecourse/memory/namespaces';

export function archivedFinalizationKey(snapshot: CourseStateSnapshot): string {
  const { stageId, learnerId, courseId, lessonId } = snapshot;
  if (
    ![stageId, learnerId, courseId, lessonId].every((id) => typeof id === 'string' && id.trim())
  ) {
    throw new Error('Cannot locate the archived classroom working session');
  }
  const expected = `finalize:${livecourseActionSessionId({ stageId, learnerId, courseId, lessonId })}`;
  const actual = snapshot.lifecycle?.finalization?.idempotencyKey ?? snapshot.idempotencyKey;
  if (actual !== expected) throw new Error('Course is already archived by an unknown writer');
  return expected;
}

/** An archive is not a post-class receipt until both original teaching W rows are absent. */
export async function needsFinalizationRecovery(
  snapshot: CourseStateSnapshot,
  store: Pick<RuntimeStore, 'getSession'>,
): Promise<boolean> {
  archivedFinalizationKey(snapshot);
  const { stageId, learnerId, courseId, lessonId } = snapshot;
  const classroomSessionId = livecourseActionSessionId({ stageId, learnerId, courseId, lessonId });
  const memoryId = workingMemorySessionId({ stageId, learnerId, classroomSessionId });
  const [actions, memory] = await Promise.all([
    store.getSession(classroomSessionId),
    store.getSession(memoryId),
  ]);
  for (const [session, id, kind] of [
    [actions, classroomSessionId, LIVECOURSE_ACTION_KIND],
    [memory, memoryId, WORKING_MEMORY_KIND],
  ] as const) {
    if (session) assertMemorySessionIdentity(session, { id, kind, stageId, learnerId });
  }
  if (snapshot.lifecycle?.finalization?.phase === 'pending') {
    if (!actions && !memory) throw new Error('Pending archive has lost its working recovery data');
    return true;
  }
  return Boolean(actions || memory);
}
