import type { LessonPlan } from '@/lib/livecourse/domain/schemas';
import type { Scene, Stage } from '@/lib/types/stage';
import {
  assertBoundShareDocument,
  bindShareMediaRefs,
  classifyShareMediaRef,
  collectShareDocumentRefs,
  resolveShareMediaBytes,
  shareMediaFilePath,
  type ShareMediaError,
} from './media';
import {
  COURSE_SHARE_SCHEMA_VERSION,
  courseShareSnapshotSchema,
  shareMediaPlaceholder,
  type CourseShareMediaEntry,
  type CourseShareMediaKind,
  type CourseShareSnapshot,
} from './schema';
import { stripShareMaterials } from './strip';

export interface ShareMediaBytes {
  path: string;
  blob: Blob;
}

export async function buildShareSnapshot(input: {
  token: string;
  stage: Stage;
  scenes: readonly Scene[];
  lessonPlan: LessonPlan;
  coursePlan?: unknown;
  createdAt?: string;
  resolveBytes?: typeof resolveShareMediaBytes;
}): Promise<{ snapshot: CourseShareSnapshot; files: ShareMediaBytes[] }> {
  const referenced = [...collectShareDocumentRefs(input.stage, input.scenes)];
  const coverRef = input.stage.coverAssetId?.trim();
  const speechRefs = new Set<string>();
  for (const scene of input.scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type === 'speech' && action.audioId) speechRefs.add(action.audioId);
    }
  }

  const usedPaths = new Set<string>();
  const manifest: CourseShareMediaEntry[] = [];
  const files: ShareMediaBytes[] = [];
  const replacements = new Map<string, string>();
  const resolveBytes = input.resolveBytes ?? resolveShareMediaBytes;

  const add = async (ref: string, kindOverride?: CourseShareMediaKind) => {
    if (replacements.has(ref)) return;
    const classified = classifyShareMediaRef(ref);
    if (classified === 'external') return;
    const kind = kindOverride ?? classified;
    const blob = await resolveBytes({
      stageId: input.stage.id,
      ref,
      kind,
    });
    const mimeType = blob.type || 'application/octet-stream';
    const path = shareMediaFilePath({ sourceRef: ref, mimeType, kind, used: usedPaths });
    manifest.push({ sourceRef: ref, path, mimeType, kind });
    files.push({ path, blob });
    replacements.set(ref, shareMediaPlaceholder(path));
  };

  if (coverRef) await add(coverRef, 'cover');
  for (const ref of speechRefs) {
    const classified = classifyShareMediaRef(ref);
    if (classified === 'external') continue;
    await add(ref, classified === 'classroom-media' ? classified : 'speech-audio');
  }
  for (const ref of referenced) {
    await add(ref);
  }

  const bound = bindShareMediaRefs({
    stage: input.stage,
    scenes: input.scenes,
    replacements,
  });
  assertBoundShareDocument(bound.stage, bound.scenes);

  const snapshot = courseShareSnapshotSchema.parse({
    schemaVersion: COURSE_SHARE_SCHEMA_VERSION,
    token: input.token,
    createdAt: input.createdAt ?? new Date().toISOString(),
    sourceStageId: input.stage.id,
    title: input.stage.name?.trim() || 'Untitled',
    sceneCount: bound.scenes.length,
    stage: stripShareMaterials(bound.stage),
    scenes: stripShareMaterials(bound.scenes),
    lessonPlan: stripShareMaterials(input.lessonPlan),
    ...(input.coursePlan === undefined ? {} : { coursePlan: stripShareMaterials(input.coursePlan) }),
    mediaManifest: manifest,
  });

  return { snapshot, files };
}

export type { ShareMediaError };
