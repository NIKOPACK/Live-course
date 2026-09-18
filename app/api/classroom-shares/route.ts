import { type NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess, API_ERROR_CODES } from '@/lib/server/api-response';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import {
  ClassroomShareQuotaError,
  MAX_SHARE_REQUEST_BYTES,
  assertShareQuota,
  createShareToken,
  writeShareSnapshot,
} from '@/lib/server/classroom-share-storage';
import { courseShareSnapshotSchema } from '@/lib/livecourse/share/schema';
import { reconcileShareSnapshot, ShareReconcileError } from '@/lib/livecourse/share/reconcile';

const log = createLogger('CourseShare');

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Expected multipart form data');
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid multipart body');
    }

    const snapshotField = form.get('snapshot');
    if (typeof snapshotField !== 'string') {
      return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'Missing snapshot');
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(snapshotField);
    } catch {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Snapshot must be JSON');
    }
    const snapshotResult = courseShareSnapshotSchema.safeParse(parsedJson);
    if (!snapshotResult.success) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid share snapshot');
    }
    const snapshot = { ...snapshotResult.data, token: createShareToken() };

    const files: Array<{ path: string; bytes: Uint8Array }> = [];
    const filePaths = new Set<string>();
    let incomingBytes = Buffer.byteLength(snapshotField, 'utf8');
    for (const [key, value] of form.entries()) {
      if (key === 'snapshot') continue;
      if (typeof value === 'string') {
        return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Unexpected text field');
      }
      const bytes = new Uint8Array(await value.arrayBuffer());
      incomingBytes += bytes.byteLength;
      files.push({ path: key, bytes });
      filePaths.add(key);
    }
    if (incomingBytes > MAX_SHARE_REQUEST_BYTES) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 413, 'Share payload exceeds 50MB');
    }

    try {
      reconcileShareSnapshot({ snapshot, filePaths });
    } catch (error) {
      if (error instanceof ShareReconcileError) {
        return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, error.message);
      }
      throw error;
    }

    try {
      await assertShareQuota(incomingBytes);
    } catch (error) {
      if (error instanceof ClassroomShareQuotaError) {
        return apiError(API_ERROR_CODES.INVALID_REQUEST, 413, error.message);
      }
      throw error;
    }

    await writeShareSnapshot({ snapshot, files });
    const origin = buildRequestOrigin(request);
    log.info(`Created share ${snapshot.token.slice(0, 4)} stage=${snapshot.sourceStageId ?? ''}`);
    return apiSuccess({ token: snapshot.token, url: `${origin}/share/${snapshot.token}` }, 201);
  } catch (error) {
    log.error('Failed to create course share', error);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to create course share');
  }
}
