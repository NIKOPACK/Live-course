import { applyClassroomStageAndScenes } from '@/lib/classroom/load-classroom';
import { outlinesFromClassroomScenes } from '@/lib/livecourse/lesson/outlines-from-scenes';
import { initializeCourseState } from '@/lib/livecourse/session/course-state-bootstrap';
import { createCourseStateRepository } from '@/lib/livecourse/session/course-state-repository';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';
import { useStageStore } from '@/lib/store/stage';
import { deleteStageData } from '@/lib/utils/stage-storage';
import type { LessonPlan } from '@/lib/livecourse/domain/schemas';
import type { CoursePlan } from '@/lib/livecourse/domain/course-plan';
import type { Scene, Stage } from '@/lib/types/stage';
import { readShareRedeemRegistration, writeShareRedeemRegistration } from './registration';

export class CourseShareRedeemError extends Error {
  override readonly name = 'CourseShareRedeemError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ShareMetadata {
  token: string;
  title: string;
  sceneCount: number;
  createdAt: string;
  hasCover: boolean;
}

export async function fetchShareMetadata(token: string): Promise<ShareMetadata> {
  const response = await fetch(`/api/classroom-shares/${encodeURIComponent(token)}`, {
    credentials: 'include',
  });
  if (response.status === 404) {
    throw new CourseShareRedeemError('Share not found', 404);
  }
  if (!response.ok) {
    throw new CourseShareRedeemError(`Failed to load share: ${response.status}`, response.status);
  }
  return (await response.json()) as ShareMetadata;
}

export async function redeemCourseShare(token: string): Promise<{
  stageId: string;
  courseId: string;
  lessonId: string;
}> {
  const existing = await readShareRedeemRegistration(token);
  if (existing) {
    return { stageId: existing.stageId, courseId: existing.courseId, lessonId: existing.lessonId };
  }

  const response = await fetch(`/api/classroom-shares/${encodeURIComponent(token)}/redeem`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!response.ok) {
    throw new CourseShareRedeemError(`Join failed: ${response.status}`, response.status);
  }
  const body = (await response.json()) as {
    stageId: string;
    courseId: string;
    lessonId: string;
    classroom: {
      stage: Stage;
      scenes: Scene[];
      lessonPlan: LessonPlan;
      coursePlan?: CoursePlan;
    };
  };

  applyClassroomStageAndScenes(body.classroom.stage, body.classroom.scenes, {
    persist: false,
    lessonPlan: body.classroom.lessonPlan,
    coursePlan: body.classroom.coursePlan,
    outlines: outlinesFromClassroomScenes(body.classroom.scenes),
    generationComplete: true,
  });

  try {
    const learnerId = await getLearnerKey();
    const repository = createCourseStateRepository({
      store: getRuntimeStore(),
      stageId: body.stageId,
      learnerId,
      courseId: body.courseId,
    });
    await initializeCourseState({
      repository,
      courseId: body.courseId,
      stageId: body.stageId,
      lessonId: body.lessonId,
      learnerId,
      lessonPlan: body.classroom.lessonPlan,
    });
    const saved = await useStageStore.getState().saveToStorage();
    if (!saved) {
      throw new CourseShareRedeemError('Failed to persist joined classroom');
    }
    await writeShareRedeemRegistration({
      token,
      stageId: body.stageId,
      courseId: body.courseId,
      lessonId: body.lessonId,
    });
  } catch (error) {
    await deleteStageData(body.stageId).catch(() => undefined);
    throw error;
  }

  return {
    stageId: body.stageId,
    courseId: body.courseId,
    lessonId: body.lessonId,
  };
}
