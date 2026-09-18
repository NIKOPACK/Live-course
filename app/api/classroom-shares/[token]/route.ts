import { type NextRequest } from 'next/server';
import { apiError, apiSuccess, API_ERROR_CODES } from '@/lib/server/api-response';
import { isValidClassroomId } from '@/lib/server/classroom-storage';
import { readShareSnapshot } from '@/lib/server/classroom-share-storage';

export async function GET(
  _request: NextRequest,
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
  return apiSuccess({
    token: snapshot.token,
    title: snapshot.title,
    sceneCount: snapshot.sceneCount,
    createdAt: snapshot.createdAt,
    hasCover: Boolean(
      snapshot.mediaManifest.some((entry) => entry.kind === 'cover') ||
        (typeof snapshot.stage === 'object' &&
          snapshot.stage !== null &&
          'coverAssetId' in snapshot.stage &&
          Boolean((snapshot.stage as { coverAssetId?: string }).coverAssetId)),
    ),
  });
}
