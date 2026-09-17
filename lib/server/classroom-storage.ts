import { promises as fs } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import type { Scene, Stage } from '@/lib/types/stage';
import { migrateCoursePlan, assertWritableCoursePlan } from '@livecourse/storage';

export const CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');
export const CLASSROOM_JOBS_DIR = path.join(process.cwd(), 'data', 'classroom-jobs');

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureClassroomsDir() {
  await ensureDir(CLASSROOMS_DIR);
}

export async function ensureClassroomJobsDir() {
  await ensureDir(CLASSROOM_JOBS_DIR);
}

export async function writeJsonFileAtomic(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tempFilePath, content, 'utf-8');
  await fs.rename(tempFilePath, filePath);
}

export function buildRequestOrigin(req: NextRequest): string {
  return req.headers.get('x-forwarded-host')
    ? `${req.headers.get('x-forwarded-proto') || 'http'}://${req.headers.get('x-forwarded-host')}`
    : req.nextUrl.origin;
}

export interface PersistedClassroomData {
  id: string;
  stage: Stage;
  scenes: Scene[];
  /**
   * Course metadata is intentionally opaque at this file-storage boundary.
   * The application/API boundary owns the full domain schema; this module
   * only preserves the versioned JSON and rejects values with no migration
   * path.
   */
  coursePlan?: unknown;
  /**
   * A1 teaching design. Opaque at this file-storage boundary; the application
   * HTTP/generation seam validates `LessonPlan` before persist and after read.
   */
  lessonPlan?: unknown;
  createdAt: string;
}

export function isValidClassroomId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id);
}

function assertValidClassroomId(id: unknown): asserts id is string {
  if (!isValidClassroomId(id)) {
    throw new Error(
      `Invalid classroom id ${JSON.stringify(id)}; ids may contain only letters, digits, dash or underscore`,
    );
  }
}

function classroomFilePath(id: string): string {
  assertValidClassroomId(id);
  return path.join(CLASSROOMS_DIR, `${id}.json`);
}

export async function readClassroom(id: string): Promise<PersistedClassroomData | null> {
  const filePath = classroomFilePath(id);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Malformed classroom record for ${JSON.stringify(id)}`);
    }
    const classroom = parsed as PersistedClassroomData;
    if (classroom.coursePlan !== undefined) {
      // Keep the storage package independent of the app's domain schema while
      // still refusing malformed/unsupported metadata instead of letting a
      // caller silently reinterpret it as a legacy classroom.
      classroom.coursePlan = migrateCoursePlan(classroom.coursePlan, id);
    }
    return classroom;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function persistClassroom(
  data: {
    id: string;
    stage: Stage;
    scenes: Scene[];
    /** Opaque here; callers at an application boundary must validate it. */
    coursePlan?: unknown;
    /** Opaque A1 LessonPlan; validated at the application boundary. */
    lessonPlan?: unknown;
  },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  assertValidClassroomId(data.id);
  if (data.stage.id !== data.id) {
    throw new Error(
      `Classroom stage id ${JSON.stringify(data.stage.id)} does not match classroom id ${JSON.stringify(data.id)}`,
    );
  }
  if (data.coursePlan !== undefined) {
    // This is the generic storage guard. It checks version/migration shape but
    // deliberately does not import the application's CoursePlan schema.
    assertWritableCoursePlan(data.coursePlan, data.id);
  }

  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes: data.scenes,
    createdAt: new Date().toISOString(),
    ...(data.coursePlan === undefined ? {} : { coursePlan: data.coursePlan }),
    ...(data.lessonPlan === undefined ? {} : { lessonPlan: data.lessonPlan }),
  };

  await ensureClassroomsDir();
  const filePath = classroomFilePath(data.id);
  await writeJsonFileAtomic(filePath, classroomData);

  return {
    ...classroomData,
    url: `${baseUrl}/classroom/${data.id}`,
  };
}

/**
 * Remove the classroom JSON file and its media directory. Idempotent: a missing
 * file or directory is success. Showcase `fourier-intro` is refused before any
 * filesystem work. Path segments come only from `CLASSROOMS_DIR` + a charset-
 * validated id; v1 does not extra-lstat against symlink escape.
 */
export async function deleteClassroom(id: string): Promise<void> {
  assertValidClassroomId(id);
  if (id === 'fourier-intro') {
    throw new Error('Showcase classroom cannot be deleted');
  }
  const filePath = classroomFilePath(id);
  const dirPath = path.join(CLASSROOMS_DIR, id);
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.rm(dirPath, { recursive: true, force: true });
}
