import { assertHtmlClassroom } from '@/lib/livecourse/lesson/html-classroom';
import { lessonPlanSchema } from '@/lib/livecourse/domain/schemas';
import type { Scene, Stage } from '@/lib/types/stage';
import { collectShareDocumentRefs } from './media';
import type { CourseShareSnapshot } from './schema';
import { SHARE_MEDIA_PATH_PATTERN, shareMediaPathFromPlaceholder } from './schema';

export class ShareReconcileError extends Error {
  override readonly name = 'ShareReconcileError';
}

export function reconcileShareSnapshot(input: {
  snapshot: CourseShareSnapshot;
  filePaths: ReadonlySet<string>;
}): void {
  const lessonPlan = lessonPlanSchema.safeParse(input.snapshot.lessonPlan);
  if (!lessonPlan.success) {
    throw new ShareReconcileError('Share snapshot is not an HTML lesson plan');
  }
  const scenes = input.snapshot.scenes as Scene[];
  try {
    assertHtmlClassroom({ lessonPlan: lessonPlan.data, scenes });
  } catch {
    throw new ShareReconcileError('Share snapshot is not an HTML classroom');
  }

  const serialized = JSON.stringify(input.snapshot);
  if (serialized.includes('blob:')) {
    throw new ShareReconcileError('Share snapshot contains blob: refs');
  }

  const expected = new Set(input.snapshot.mediaManifest.map((entry) => entry.path));
  for (const path of expected) {
    if (!SHARE_MEDIA_PATH_PATTERN.test(path) || !input.filePaths.has(path)) {
      throw new ShareReconcileError(`Missing share media file ${path}`);
    }
  }
  for (const path of input.filePaths) {
    if (!expected.has(path)) {
      throw new ShareReconcileError(`Unexpected share media file ${path}`);
    }
  }

  const stage = input.snapshot.stage as Stage;
  for (const ref of collectShareDocumentRefs(stage, scenes)) {
    const path = shareMediaPathFromPlaceholder(ref);
    if (path) {
      if (!expected.has(path)) {
        throw new ShareReconcileError(`Document references missing file ${path}`);
      }
      continue;
    }
    if (/^https?:\/\//i.test(ref)) continue;
    throw new ShareReconcileError(`Unaccounted media ref ${ref}`);
  }
}
