import type { AgentInfo } from '@/lib/generation/pipeline-types';
import type { ImageMapping, PdfImage } from '@/lib/types/generation';

/** Parameters needed to resume scene generation after entering the classroom. */
export interface StageGenerationParams {
  courseId: string;
  stageId: string;
  lessonId: string;
  pdfImages?: PdfImage[];
  imageMapping?: ImageMapping;
  agents?: AgentInfo[];
  userProfile?: string;
  languageDirective?: string;
}

/** Storage adapter kept injectable so the boundary is testable without a DOM. */
export interface GenerationParamsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class GenerationParamsError extends Error {
  override readonly name = 'GenerationParamsError';
}

const GENERATION_PARAMS_PREFIX = 'generationParams';
const LEGACY_GENERATION_PARAMS_KEY = 'generationParams';

/** Preview keeps this until classroom load succeeds; load failure returns to preview. */
export const PENDING_CLASSROOM_ENTER_KEY = 'pendingClassroomEnter';

/** Set by classroom load failure so preview can show retry copy after replace. */
export const PENDING_CLASSROOM_ENTER_FAILED_KEY = 'pendingClassroomEnterFailed';

function requireStageId(stageId: string): string {
  const normalized = stageId.trim();
  if (!normalized) {
    throw new GenerationParamsError('Generation parameters require a non-empty stageId');
  }
  return normalized;
}

/**
 * Return the stage-scoped key. Encoding keeps arbitrary persisted stage ids
 * from colliding with the delimiter or with another id's spelling.
 */
export function generationParamsStorageKey(stageId: string): string {
  return `${GENERATION_PARAMS_PREFIX}:${encodeURIComponent(requireStageId(stageId))}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireIdentityField(value: unknown, field: keyof StageGenerationParams): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GenerationParamsError(`Generation parameters have an invalid ${field}`);
  }
  return value.trim();
}

function parseGenerationParams(
  raw: string,
  stageId: string,
  source: string,
): StageGenerationParams {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new GenerationParamsError(
      `Generation parameters in ${source} are not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new GenerationParamsError(`Generation parameters in ${source} are not an object`);
  }

  const parsedStageId = requireIdentityField(parsed.stageId, 'stageId');
  if (parsedStageId !== stageId) {
    throw new GenerationParamsError(
      `Generation parameters belong to stage ${JSON.stringify(parsedStageId)}, not ${JSON.stringify(stageId)}`,
    );
  }

  const courseId = requireIdentityField(parsed.courseId, 'courseId');
  const lessonId = requireIdentityField(parsed.lessonId, 'lessonId');
  return {
    courseId,
    stageId: parsedStageId,
    lessonId,
    ...(Array.isArray(parsed.pdfImages) ? { pdfImages: parsed.pdfImages as PdfImage[] } : {}),
    ...(isRecord(parsed.imageMapping) ? { imageMapping: parsed.imageMapping as ImageMapping } : {}),
    ...(Array.isArray(parsed.agents) ? { agents: parsed.agents as AgentInfo[] } : {}),
    ...(typeof parsed.userProfile === 'string' ? { userProfile: parsed.userProfile } : {}),
    ...(typeof parsed.languageDirective === 'string'
      ? { languageDirective: parsed.languageDirective }
      : {}),
  };
}

/**
 * Read parameters for exactly one stage. A legacy global key is accepted only
 * when it carries the complete identity bundle and its stageId matches; old
 * payloads without identity therefore fail closed instead of leaking another
 * classroom's images or agents into this one.
 */
export function readGenerationParams(
  storage: Pick<GenerationParamsStorage, 'getItem'>,
  stageId: string,
): StageGenerationParams | null {
  const normalizedStageId = requireStageId(stageId);
  const scopedKey = generationParamsStorageKey(normalizedStageId);
  const scopedRaw = storage.getItem(scopedKey);
  if (scopedRaw !== null) {
    return parseGenerationParams(scopedRaw, normalizedStageId, scopedKey);
  }

  const legacyRaw = storage.getItem(LEGACY_GENERATION_PARAMS_KEY);
  if (legacyRaw === null) return null;
  return parseGenerationParams(legacyRaw, normalizedStageId, LEGACY_GENERATION_PARAMS_KEY);
}

/** Persist a complete identity bundle under the target stage's key. */
export function writeGenerationParams(
  storage: Pick<GenerationParamsStorage, 'setItem'>,
  params: StageGenerationParams,
): void {
  const stageId = requireStageId(params.stageId);
  // Validate all identity fields before writing anything; a partial write is
  // indistinguishable from a corrupt resume envelope on the next load.
  const normalized = parseGenerationParams(JSON.stringify(params), stageId, 'generated payload');
  storage.setItem(generationParamsStorageKey(stageId), JSON.stringify(normalized));
}

/** Remove only one stage's scoped resume envelope. */
export function clearGenerationParams(
  storage: Pick<GenerationParamsStorage, 'removeItem'>,
  stageId: string,
): void {
  storage.removeItem(generationParamsStorageKey(stageId));
}

export const LEGACY_GENERATION_PARAMS_STORAGE_KEY = LEGACY_GENERATION_PARAMS_KEY;
