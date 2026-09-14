import type { LessonNodeDesign, LessonPlan } from '@/lib/livecourse/domain/schemas';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

import {
  PENDING_CLASSROOM_ENTER_FAILED_KEY,
  PENDING_CLASSROOM_ENTER_KEY,
} from '@/lib/livecourse/session/generation-params';

export { PENDING_CLASSROOM_ENTER_FAILED_KEY, PENDING_CLASSROOM_ENTER_KEY };

export type SegmentStatus = 'waiting' | 'generating' | 'completed' | 'failed';
export type GeneratingPhase = 'content' | 'actions';

export interface SegmentProgress {
  outlineId: string;
  order: number;
  title: string;
  status: SegmentStatus;
  design?: LessonNodeDesign;
  scene?: Scene;
  generatingPhase?: GeneratingPhase;
}

export function deriveSegmentProgress(input: {
  outlines: readonly SceneOutline[];
  scenes: readonly Scene[];
  failedOutlines: readonly SceneOutline[];
  generatingOutlines: readonly SceneOutline[];
  lessonPlan?: LessonPlan | null;
  generatingPhase?: { outlineId: string; phase: GeneratingPhase } | null;
}): SegmentProgress[] {
  const completedOrders = new Set(input.scenes.map((scene) => scene.order));
  const failedIds = new Set(input.failedOutlines.map((outline) => outline.id));
  const generatingIds = new Set(input.generatingOutlines.map((outline) => outline.id));

  return [...input.outlines]
    .sort((left, right) => left.order - right.order)
    .map((outline) => {
      const design = input.lessonPlan?.nodes.find(
        (node) => node.sceneId === outline.id || node.order === outline.order,
      )?.design;
      const scene =
        input.scenes.find((item) => item.outlineId === outline.id) ??
        input.scenes.find((item) => item.order === outline.order);
      const status: SegmentStatus = completedOrders.has(outline.order)
        ? 'completed'
        : failedIds.has(outline.id)
          ? 'failed'
          : generatingIds.has(outline.id)
            ? 'generating'
            : 'waiting';
      return {
        outlineId: outline.id,
        order: outline.order,
        title: outline.title,
        status,
        design,
        scene,
        generatingPhase:
          status === 'generating' && input.generatingPhase?.outlineId === outline.id
            ? input.generatingPhase.phase
            : undefined,
      };
    });
}

export function allSegmentsCompleted(segments: readonly SegmentProgress[]): boolean {
  return segments.length > 0 && segments.every((segment) => segment.status === 'completed');
}

/** J2.2: only a failed segment may be retried; success segments stay completed. */
export function canRetrySegment(status: SegmentStatus): boolean {
  return status === 'failed';
}

/**
 * J2.1: in-progress (non-failed) and completed segments can open the
 * read-only lesson-plan + classroom-material view.
 */
export function canOpenSegmentMaterials(status: SegmentStatus): boolean {
  return status === 'waiting' || status === 'generating' || status === 'completed';
}

/** J2.3: enter classroom only after every segment is completed and not already navigating. */
export function canEnterClassroom(segments: readonly SegmentProgress[], entering = false): boolean {
  return allSegmentsCompleted(segments) && !entering;
}

/**
 * J2.3: a successful save with a stage id is the only navigation target.
 * Missing save / missing id stays on preview.
 */
export function classroomEnterTarget(input: {
  saved: boolean;
  stageId?: string | null;
}): string | null {
  if (!input.saved) return null;
  const stageId = input.stageId?.trim();
  return stageId ? stageId : null;
}

/**
 * Classroom load failure redirects back with this flag. Consume it once so
 * the preview can show retry copy without auto-navigating again.
 */
export function consumePendingClassroomEnterFailure(storage: {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}): boolean {
  if (!storage.getItem(PENDING_CLASSROOM_ENTER_FAILED_KEY)) return false;
  storage.removeItem(PENDING_CLASSROOM_ENTER_FAILED_KEY);
  storage.removeItem(PENDING_CLASSROOM_ENTER_KEY);
  return true;
}
