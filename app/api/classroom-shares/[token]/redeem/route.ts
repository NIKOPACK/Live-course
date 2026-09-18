import { nanoid } from 'nanoid';
import { type NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess, API_ERROR_CODES } from '@/lib/server/api-response';
import { buildRequestOrigin, isValidClassroomId } from '@/lib/server/classroom-storage';
import { persistRedeemedClassroom, readShareSnapshot } from '@/lib/server/classroom-share-storage';
import { rewriteShareMaterials, ShareRewriteError } from '@/lib/livecourse/share/rewrite';

const log = createLogger('CourseShare');

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!isValidClassroomId(token)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid share token');
  }
  const snapshot = await readShareSnapshot(token);
  if (!snapshot) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Share not found');
  }

  try {
    const rewritten = rewriteShareMaterials({
      snapshot,
      newSeed: nanoid(),
      token,
      origin: buildRequestOrigin(request),
    });
    const persisted = await persistRedeemedClassroom({
      identity: rewritten.identity,
      stage: rewritten.stage,
      scenes: rewritten.scenes,
      lessonPlan: rewritten.lessonPlan,
      coursePlan: rewritten.coursePlan,
      token,
      origin: buildRequestOrigin(request),
    });
    log.info(`Redeemed share ${token.slice(0, 4)} -> ${rewritten.identity.stageId}`);
    return apiSuccess(
      {
        stageId: rewritten.identity.stageId,
        courseId: rewritten.identity.courseId,
        lessonId: rewritten.identity.lessonId,
        classroom: {
          id: persisted.id,
          stage: rewritten.stage,
          scenes: rewritten.scenes,
          lessonPlan: rewritten.lessonPlan,
          coursePlan: rewritten.coursePlan,
        },
      },
      201,
    );
  } catch (error) {
    if (error instanceof ShareRewriteError) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, error.message);
    }
    log.error('Failed to redeem course share', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to join shared course');
  }
}
