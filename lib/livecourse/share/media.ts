import { replaceHtmlMediaReferences } from '@/lib/livecourse/html/media';
import { collectStageAssetRefs } from '@/lib/media/collect-stage-asset-refs';
import { slideMediaReferenceSlots } from '@/lib/media/slide-media-slots';
import type { Scene, Stage } from '@/lib/types/stage';
import type { Slide } from '@livecourse/dsl';
import {
  SHARE_MEDIA_PREFIX,
  type CourseShareMediaEntry,
  type CourseShareMediaKind,
  shareMediaPathFromPlaceholder,
  shareMediaPlaceholder,
} from './schema';

const CLASSROOM_MEDIA_RE =
  /(?:^https?:\/\/[^/?#]+)?\/api\/classroom-media\/[^/]+\/((?:media|audio)\/[A-Za-z0-9._-]+)/i;

export class ShareMediaError extends Error {
  override readonly name = 'ShareMediaError';
}

export function classifyShareMediaRef(ref: string): CourseShareMediaKind | 'external' {
  const value = ref.trim();
  if (!value) throw new ShareMediaError('Empty media ref');
  if (value.startsWith('#')) return 'external';
  if (value.startsWith('blob:')) return 'blob';
  if (value.startsWith('data:')) return 'data';
  if (CLASSROOM_MEDIA_RE.test(value)) return 'classroom-media';
  if (/^(?:gen_(?:img|vid)|lesson_img)_[\w-]+$/i.test(value)) return 'placeholder';
  if (/^https?:\/\//i.test(value)) return 'external';
  if (value.startsWith(SHARE_MEDIA_PREFIX)) return 'external';
  if (/^(?:\/|\.\.?\/)/.test(value) && !CLASSROOM_MEDIA_RE.test(value)) return 'external';
  return 'pool';
}

function extFromMime(mimeType: string): string {
  const mime = mimeType.toLowerCase();
  if (mime.includes('png')) return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('aac')) return '.aac';
  return '.bin';
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 8);
}

export function shareMediaFilePath(input: {
  sourceRef: string;
  mimeType: string;
  kind: CourseShareMediaKind;
  used: Set<string>;
}): string {
  const directory =
    input.kind === 'speech-audio' || input.mimeType.toLowerCase().startsWith('audio/')
      ? 'audio'
      : 'media';
  const ext = extFromMime(input.mimeType);
  const raw = input.sourceRef.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  const safe = (raw.slice(0, 80) || 'asset').replace(/^\.+/, 'asset');
  let path = `${directory}/${safe}${ext}`;
  if (input.used.has(path)) {
    path = `${directory}/${safe}_${shortHash(input.sourceRef)}${ext}`;
  }
  input.used.add(path);
  return path;
}

async function defaultReadPoolBlob(ref: string): Promise<Blob | null> {
  const { withAssetUrl } = await import('@/lib/media/use-asset-url');
  return withAssetUrl(ref, async (url) => (url ? (await fetch(url)).blob() : null));
}

async function defaultReadMediaFile(key: string): Promise<Blob | null> {
  const { db } = await import('@/lib/utils/database');
  const row = await db.mediaFiles.get(key);
  return row?.blob ?? null;
}

async function defaultReadAudioBlob(audioId: string): Promise<Blob | null> {
  const { resolveAudioBlob } = await import('@/lib/media/resolve-audio-bytes');
  return resolveAudioBlob(audioId);
}

function decodeDataUrl(ref: string): Blob {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(ref);
  if (!match) throw new ShareMediaError('Invalid data URL');
  const mimeType = match[1]?.trim() || 'application/octet-stream';
  const payload = match[3] ?? '';
  if (match[2]) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  }
  return new Blob([decodeURIComponent(payload)], { type: mimeType });
}

export async function resolveShareMediaBytes(input: {
  stageId: string;
  ref: string;
  kind: CourseShareMediaKind;
  readPoolBlob?: (ref: string) => Promise<Blob | null>;
  readMediaFile?: (key: string) => Promise<Blob | null>;
  readAudioBlob?: (audioId: string) => Promise<Blob | null>;
}): Promise<Blob> {
  const readPoolBlob = input.readPoolBlob ?? defaultReadPoolBlob;
  const readMediaFile = input.readMediaFile ?? defaultReadMediaFile;
  const readAudioBlob = input.readAudioBlob ?? defaultReadAudioBlob;

  if (input.kind === 'speech-audio') {
    const blob = await readAudioBlob(input.ref);
    if (!blob) throw new ShareMediaError(`Missing speech audio bytes for ${input.ref}`);
    return blob;
  }
  if (input.kind === 'blob') {
    const response = await fetch(input.ref);
    if (!response.ok) throw new ShareMediaError(`Failed to read blob: ${input.ref}`);
    return response.blob();
  }
  if (input.kind === 'data') {
    return decodeDataUrl(input.ref);
  }
  if (input.kind === 'classroom-media') {
    const response = await fetch(input.ref, { credentials: 'include' });
    if (!response.ok) throw new ShareMediaError(`Failed to copy classroom media ${input.ref}`);
    return response.blob();
  }

  const pooled = await readPoolBlob(input.ref);
  if (pooled) return pooled;
  const { mediaFileKey } = await import('@/lib/utils/database');
  const stored = await readMediaFile(mediaFileKey(input.stageId, input.ref));
  if (stored) return stored;
  throw new ShareMediaError(`Missing media bytes for ${input.ref}`);
}

function rewriteSlideSlots(
  slide: Pick<Slide, 'background' | 'elements'>,
  map: Map<string, string>,
) {
  for (const slot of slideMediaReferenceSlots(slide)) {
    const current = slot.read();
    if (!current) continue;
    const next = map.get(current);
    if (next) slot.write(next);
  }
}

export function bindShareMediaRefs(input: {
  stage: Stage;
  scenes: readonly Scene[];
  replacements: ReadonlyMap<string, string>;
}): { stage: Stage; scenes: Scene[] } {
  const stage = structuredClone(input.stage);
  const scenes = structuredClone([...input.scenes]) as Scene[];
  const htmlMap = Object.fromEntries(input.replacements);
  const rewrite = (value: string | undefined): string | undefined => {
    if (!value) return value;
    return input.replacements.get(value) ?? value;
  };

  for (const scene of scenes) {
    if (
      (scene.content.type === 'interactive' || scene.content.type === 'quiz') &&
      scene.content.html
    ) {
      scene.content.html = replaceHtmlMediaReferences(scene.content.html, htmlMap);
    }
    if (scene.content.type === 'slide') {
      rewriteSlideSlots(scene.content.canvas, input.replacements as Map<string, string>);
    }
    for (const board of scene.whiteboards ?? []) {
      rewriteSlideSlots(board, input.replacements as Map<string, string>);
    }
    for (const action of scene.actions ?? []) {
      if (action.type !== 'speech' || !action.audioId) continue;
      const next = input.replacements.get(action.audioId);
      if (!next) continue;
      action.audioId = next;
      if (/^https?:\/\//i.test(next)) action.audioUrl = next;
      else delete action.audioUrl;
    }
  }

  if (stage.whiteboard) {
    for (const board of stage.whiteboard) {
      rewriteSlideSlots(board, input.replacements as Map<string, string>);
    }
  }
  if (stage.coverAssetId) {
    stage.coverAssetId = rewrite(stage.coverAssetId);
  }
  if (stage.videoManifest) {
    const nextManifest: NonNullable<Stage['videoManifest']> = {};
    for (const [key, value] of Object.entries(stage.videoManifest)) {
      nextManifest[rewrite(key) ?? key] = value;
    }
    stage.videoManifest = nextManifest;
  }

  return { stage, scenes };
}

export function collectShareDocumentRefs(stage: Stage, scenes: readonly Scene[]): Set<string> {
  return new Set(
    collectStageAssetRefs({ stage, scenes }, { mediaRows: [], audioRows: [] }).referenced,
  );
}

export function assertBoundShareDocument(stage: Stage, scenes: readonly Scene[]): void {
  const serialized = JSON.stringify({ stage, scenes });
  if (serialized.includes('blob:')) {
    throw new ShareMediaError('Bound share document still contains blob: refs');
  }
  for (const ref of collectShareDocumentRefs(stage, scenes)) {
    if (shareMediaPathFromPlaceholder(ref)) continue;
    const kind = classifyShareMediaRef(ref);
    if (kind === 'external') continue;
    throw new ShareMediaError(`Unaccounted media ref after bind: ${ref}`);
  }
}

export function classroomMediaUrl(origin: string, stageId: string, path: string): string {
  const base = origin.replace(/\/$/, '');
  if (!base) throw new ShareMediaError('Missing origin for classroom media URL');
  return `${base}/api/classroom-media/${stageId}/${path}`;
}

export function replaceShareMediaPlaceholders(
  stage: Stage,
  scenes: Scene[],
  stageId: string,
  origin: string,
): { stage: Stage; scenes: Scene[] } {
  const replacements = new Map<string, string>();
  for (const ref of collectShareDocumentRefs(stage, scenes)) {
    const path = shareMediaPathFromPlaceholder(ref);
    if (path) replacements.set(ref, classroomMediaUrl(origin, stageId, path));
  }
  if (replacements.size === 0) return { stage, scenes };
  return bindShareMediaRefs({ stage, scenes, replacements });
}

export { SHARE_MEDIA_PREFIX };
