import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import type { CourseShareSnapshot } from '@/lib/livecourse/share/schema';
import { SHARE_MEDIA_PATH_PATTERN, courseShareSnapshotSchema } from '@/lib/livecourse/share/schema';
import {
  CLASSROOMS_DIR,
  isValidClassroomId,
  persistClassroom,
  writeJsonFileAtomic,
} from '@/lib/server/classroom-storage';
import type { Scene, Stage } from '@/lib/types/stage';
import type { LessonPlan } from '@/lib/livecourse/domain/schemas';
import type { CoursePlan } from '@/lib/livecourse/domain/course-plan';

export const CLASSROOM_SHARES_DIR = path.join(process.cwd(), 'data', 'classroom-shares');

export const MAX_SHARE_REQUEST_BYTES = 50 * 1024 * 1024;
export const MAX_SHARE_SNAPSHOT_COUNT = 100;
export const MAX_SHARE_DISK_BYTES = 2 * 1024 * 1024 * 1024;

export class ClassroomShareQuotaError extends Error {
  override readonly name = 'ClassroomShareQuotaError';
  readonly status = 413;
}

export class ClassroomShareNotFoundError extends Error {
  override readonly name = 'ClassroomShareNotFoundError';
}

function shareJsonPath(token: string): string {
  if (!isValidClassroomId(token)) {
    throw new Error(`Invalid share token ${JSON.stringify(token)}`);
  }
  return path.join(CLASSROOM_SHARES_DIR, `${token}.json`);
}

function shareDir(token: string): string {
  if (!isValidClassroomId(token)) {
    throw new Error(`Invalid share token ${JSON.stringify(token)}`);
  }
  return path.join(CLASSROOM_SHARES_DIR, token);
}

export function createShareToken(): string {
  return randomBytes(16).toString('base64url');
}

async function directorySize(dir: string): Promise<number> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await directorySize(full);
      } else if (entry.isFile()) {
        total += (await fs.stat(full)).size;
      }
    }
    return total;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

export async function countShareSnapshots(): Promise<number> {
  try {
    const entries = await fs.readdir(CLASSROOM_SHARES_DIR, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

export async function assertShareQuota(incomingBytes: number): Promise<void> {
  const count = await countShareSnapshots();
  if (count >= MAX_SHARE_SNAPSHOT_COUNT) {
    throw new ClassroomShareQuotaError('Share snapshot limit reached');
  }
  const used = await directorySize(CLASSROOM_SHARES_DIR);
  if (used + incomingBytes > MAX_SHARE_DISK_BYTES) {
    throw new ClassroomShareQuotaError('Share disk quota exceeded');
  }
}

export async function readShareSnapshot(token: string): Promise<CourseShareSnapshot | null> {
  try {
    const raw = await fs.readFile(shareJsonPath(token), 'utf-8');
    const parsed = courseShareSnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeShareSnapshot(input: {
  snapshot: CourseShareSnapshot;
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>;
}): Promise<void> {
  const token = input.snapshot.token;
  await fs.mkdir(CLASSROOM_SHARES_DIR, { recursive: true });
  try {
    await fs.access(shareJsonPath(token));
    throw new Error('Share token already exists');
  } catch (error) {
    if (error instanceof Error && error.message === 'Share token already exists') throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const dir = shareDir(token);
  await fs.mkdir(path.join(dir, 'media'), { recursive: true });
  await fs.mkdir(path.join(dir, 'audio'), { recursive: true });
  for (const file of input.files) {
    if (!SHARE_MEDIA_PATH_PATTERN.test(file.path)) {
      throw new Error(`Invalid share media path ${file.path}`);
    }
    const dest = path.join(dir, file.path);
    const resolvedBase = path.resolve(dir);
    const resolvedDest = path.resolve(dest);
    if (!resolvedDest.startsWith(resolvedBase + path.sep) && resolvedDest !== resolvedBase) {
      throw new Error('Share media path escaped snapshot directory');
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file.bytes);
  }
  await writeJsonFileAtomic(shareJsonPath(token), input.snapshot);
}

export async function copyShareMediaToClassroom(token: string, stageId: string): Promise<void> {
  const fromDir = shareDir(token);
  const toDir = path.join(CLASSROOMS_DIR, stageId);
  await fs.mkdir(toDir, { recursive: true });
  for (const sub of ['media', 'audio'] as const) {
    const source = path.join(fromDir, sub);
    const dest = path.join(toDir, sub);
    try {
      await fs.cp(source, dest, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

export async function persistRedeemedClassroom(input: {
  identity: { stageId: string };
  stage: Stage;
  scenes: Scene[];
  lessonPlan: LessonPlan;
  coursePlan: CoursePlan;
  token: string;
  origin: string;
}): Promise<{ id: string; url: string }> {
  const persisted = await persistClassroom(
    {
      id: input.identity.stageId,
      stage: input.stage,
      scenes: input.scenes,
      lessonPlan: input.lessonPlan,
      coursePlan: input.coursePlan,
    },
    input.origin,
  );
  await copyShareMediaToClassroom(input.token, input.identity.stageId);
  return { id: persisted.id, url: persisted.url };
}
