import { z } from 'zod';

export const COURSE_SHARE_SCHEMA_VERSION = 1 as const;
export const SHARE_MEDIA_PREFIX = '__SHARE_MEDIA__/';

export const SHARE_TOKEN_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const SHARE_MEDIA_PATH_PATTERN = /^(media|audio)\/[A-Za-z0-9._-]+$/;

export const courseShareMediaKindSchema = z.enum([
  'placeholder',
  'pool',
  'blob',
  'data',
  'classroom-media',
  'speech-audio',
  'cover',
]);

export const courseShareMediaEntrySchema = z
  .object({
    sourceRef: z.string().trim().min(1).max(2000),
    path: z.string().regex(SHARE_MEDIA_PATH_PATTERN),
    mimeType: z.string().trim().min(1).max(200),
    kind: courseShareMediaKindSchema,
  })
  .strict();

export const courseShareSnapshotSchema = z
  .object({
    schemaVersion: z.literal(COURSE_SHARE_SCHEMA_VERSION),
    token: z.string().regex(SHARE_TOKEN_PATTERN).min(16).max(64),
    createdAt: z.string().datetime({ offset: true }),
    sourceStageId: z.string().optional(),
    title: z.string().trim().min(1).max(500),
    sceneCount: z.number().int().nonnegative(),
    stage: z.unknown(),
    scenes: z.array(z.unknown()),
    lessonPlan: z.unknown(),
    coursePlan: z.unknown().optional(),
    outlines: z.array(z.unknown()).optional(),
    mediaManifest: z.array(courseShareMediaEntrySchema),
  })
  .strict();

export type CourseShareMediaKind = z.infer<typeof courseShareMediaKindSchema>;
export type CourseShareMediaEntry = z.infer<typeof courseShareMediaEntrySchema>;
export type CourseShareSnapshot = z.infer<typeof courseShareSnapshotSchema>;

export function shareMediaPlaceholder(path: string): string {
  return `${SHARE_MEDIA_PREFIX}${path}`;
}

export function isShareMediaPlaceholder(value: string): boolean {
  return value.startsWith(SHARE_MEDIA_PREFIX);
}

export function shareMediaPathFromPlaceholder(value: string): string | null {
  if (!value.startsWith(SHARE_MEDIA_PREFIX)) return null;
  const path = value.slice(SHARE_MEDIA_PREFIX.length);
  return SHARE_MEDIA_PATH_PATTERN.test(path) ? path : null;
}
