import type { LiveCourseDocument } from '@livecourse/storage';
import type { Stage } from '@livecourse/dsl';

import type { SceneOutline } from '@/lib/types/generation';
import type { AppScene } from '@/lib/types/stage';
import type { LessonPlan } from '@/lib/livecourse/domain/schemas';

/** App-owned stage shape. Device playback position is not document metadata. */
export type AppStage = Stage;

/** Generation intent stored opaquely with the document aggregate. */
export interface AppDocumentOutline {
  outlines: SceneOutline[];
  /** A1：生成期写入的教案。旧课没有它，课堂运行时回退反推。 */
  lessonPlan?: LessonPlan;
  generationComplete?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Canonical app document persisted through the document-store seam. */
// `coursePlan` remains opaque at the generic storage boundary.  Consumers that
// use it as an application contract must call `parseCoursePlan` explicitly;
// this keeps migration and every backend adapter assignable without importing
// the app domain into the storage seam.
export type AppDocument = LiveCourseDocument<AppScene, AppStage>;
