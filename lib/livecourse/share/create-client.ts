import { assertHtmlClassroom } from '@/lib/livecourse/lesson/html-classroom';
import { lessonPlanSchema, type LessonPlan } from '@/lib/livecourse/domain/schemas';
import { loadStageData } from '@/lib/utils/stage-storage';
import { buildShareSnapshot } from './build-snapshot';
import { createShareToken } from './token';

export class CourseShareCreateError extends Error {
  override readonly name = 'CourseShareCreateError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function createCourseShare(stageId: string): Promise<{ token: string; url: string }> {
  const data = await loadStageData(stageId);
  if (!data) {
    throw new CourseShareCreateError('Classroom not found');
  }
  if (data.outline?.generationComplete !== true) {
    throw new CourseShareCreateError('Classroom is not generation complete');
  }
  const parsedPlan = lessonPlanSchema.safeParse(data.outline.lessonPlan);
  if (!parsedPlan.success) {
    throw new CourseShareCreateError('Classroom is not an HTML lesson');
  }
  const lessonPlan: LessonPlan = parsedPlan.data;
  assertHtmlClassroom({ lessonPlan, scenes: data.scenes });

  const token = createShareToken();
  const { snapshot, files } = await buildShareSnapshot({
    token,
    stage: data.stage,
    scenes: data.scenes,
    lessonPlan,
    coursePlan: data.coursePlan ?? undefined,
  });

  const form = new FormData();
  form.set('snapshot', JSON.stringify(snapshot));
  for (const file of files) {
    form.set(file.path, file.blob, file.path.split('/').pop());
  }

  const response = await fetch('/api/classroom-shares', {
    method: 'POST',
    body: form,
    credentials: 'include',
  });
  if (!response.ok) {
    throw new CourseShareCreateError(`Share failed: ${response.status}`, response.status);
  }
  const body = (await response.json()) as { token?: string; url?: string };
  if (!body.token || !body.url) {
    throw new CourseShareCreateError('Share response missing token');
  }
  return { token: body.token, url: body.url };
}
