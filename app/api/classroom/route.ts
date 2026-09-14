import { type NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { coursePlanSchema } from '@/lib/livecourse/domain/course-plan';
import { lessonPlanSchema } from '@/lib/livecourse/domain/schemas';
import type { Scene, Stage } from '@/lib/types/stage';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  buildRequestOrigin,
  isValidClassroomId,
  persistClassroom,
  readClassroom,
} from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('Classroom API');

export async function POST(request: NextRequest) {
  let stageId: string | undefined;
  let sceneCount: number | undefined;
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Request body must be valid JSON');
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Request body must be an object');
    }

    const {
      stage,
      scenes,
      coursePlan: rawCoursePlan,
      lessonPlan: rawLessonPlan,
    } = body as {
      stage?: unknown;
      scenes?: unknown;
      coursePlan?: unknown;
      lessonPlan?: unknown;
    };
    const stageRecord =
      typeof stage === 'object' && stage !== null && !Array.isArray(stage)
        ? (stage as Record<string, unknown>)
        : undefined;
    stageId = typeof stageRecord?.id === 'string' ? stageRecord.id : undefined;
    sceneCount = Array.isArray(scenes) ? scenes.length : undefined;

    if (
      typeof stage !== 'object' ||
      stage === null ||
      Array.isArray(stage) ||
      !Array.isArray(scenes)
    ) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required fields: stage, scenes',
      );
    }

    const rawStageId = stageRecord?.id;
    const id = rawStageId === undefined ? randomUUID() : rawStageId;
    if (typeof id !== 'string' || !isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    let coursePlan: unknown;
    if (rawCoursePlan !== undefined) {
      const parsedCoursePlan = coursePlanSchema.safeParse(rawCoursePlan);
      if (!parsedCoursePlan.success) {
        return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid course plan');
      }
      // The storage boundary remains opaque, but persist the schema-normalized
      // value produced by the application boundary. This prevents whitespace
      // or other coercible input from becoming a second identity on disk.
      coursePlan = parsedCoursePlan.data;
    }

    let lessonPlan: unknown;
    if (rawLessonPlan !== undefined) {
      const parsedLessonPlan = lessonPlanSchema.safeParse(rawLessonPlan);
      if (!parsedLessonPlan.success) {
        return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid lesson plan');
      }
      lessonPlan = parsedLessonPlan.data;
    }

    const normalizedStage = { ...stageRecord, id } as Stage;
    const baseUrl = buildRequestOrigin(request);

    const persisted = await persistClassroom(
      {
        id,
        stage: normalizedStage,
        scenes: scenes as Scene[],
        ...(coursePlan === undefined ? {} : { coursePlan }),
        ...(lessonPlan === undefined ? {} : { lessonPlan }),
      },
      baseUrl,
    );

    return apiSuccess({ id: persisted.id, url: persisted.url }, 201);
  } catch (error) {
    log.error(
      `Classroom storage failed [stageId=${stageId ?? 'unknown'}, scenes=${sceneCount ?? 0}]:`,
      error,
    );
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to store classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');

    if (!id) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required parameter: id',
      );
    }

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const classroom = await readClassroom(id);
    if (!classroom) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    // `readClassroom` performs the storage package's opaque migration guard;
    // repeat the full app-domain validation at this HTTP boundary so a
    // semantically corrupt file cannot be returned and later treated as a
    // legacy classroom by a caller.
    let coursePlan = classroom.coursePlan;
    if (coursePlan !== undefined) {
      const parsedCoursePlan = coursePlanSchema.safeParse(coursePlan);
      if (!parsedCoursePlan.success) {
        throw new Error(`Stored classroom ${JSON.stringify(id)} has an invalid course plan`);
      }
      coursePlan = parsedCoursePlan.data;
    }
    let lessonPlan = classroom.lessonPlan;
    if (lessonPlan !== undefined) {
      const parsedLessonPlan = lessonPlanSchema.safeParse(lessonPlan);
      if (!parsedLessonPlan.success) {
        throw new Error(`Stored classroom ${JSON.stringify(id)} has an invalid lesson plan`);
      }
      lessonPlan = parsedLessonPlan.data;
    }
    return apiSuccess({
      classroom: {
        ...classroom,
        ...(coursePlan === undefined ? {} : { coursePlan }),
        ...(lessonPlan === undefined ? {} : { lessonPlan }),
      },
    });
  } catch (error) {
    log.error(
      `Classroom retrieval failed [id=${request.nextUrl.searchParams.get('id') ?? 'unknown'}]:`,
      error,
    );
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to retrieve classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}
