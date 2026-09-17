import { createLogger } from '@/lib/logger';
import { deleteStageData, listStages } from '@/lib/utils/stage-storage';

const log = createLogger('DeleteUserClassroom');

export class ShowcaseClassroomDeleteError extends Error {
  override readonly name = 'ShowcaseClassroomDeleteError';

  constructor() {
    super('Showcase classroom cannot be deleted');
  }
}

/**
 * Homepage course delete (docs/spec J4.5). Server DELETE first, then the
 * existing local cascade. Success is `listStages()` no longer containing
 * `stageId`, not whether `deleteStageData` threw.
 *
 * Does not touch sessionStorage or React state.
 */
export async function deleteUserClassroom(stageId: string): Promise<void> {
  if (stageId === 'fourier-intro') {
    throw new ShowcaseClassroomDeleteError();
  }
  await deleteClassroomOnServer(stageId);
  let thrown: unknown;
  try {
    await deleteStageData(stageId);
  } catch (error) {
    thrown = error;
  }
  const stillListed = (await listStages()).some((item) => item.id === stageId);
  if (stillListed) {
    throw thrown instanceof Error ? thrown : new Error('Classroom is still in the local list');
  }
  if (thrown) {
    log.warn(`deleteStageData threw after the document left listStages (${stageId}):`, thrown);
  }
}

async function deleteClassroomOnServer(stageId: string): Promise<void> {
  const res = await fetch(`/api/classroom?id=${encodeURIComponent(stageId)}`, {
    method: 'DELETE',
  });
  if (res.status === 404 || res.ok) return;
  throw new Error(`DELETE /api/classroom failed: ${res.status}`);
}
