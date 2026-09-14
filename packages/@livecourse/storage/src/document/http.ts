import { migrate, validateScene, validateStage } from '@livecourse/dsl';
import type { Scene, Stage } from '@livecourse/dsl';
import { assertJsonValue } from '../runtime/json-value.js';
import type {
  DocumentStore,
  DocumentSummary,
  LiveCourseDocument,
  SceneLike,
  SceneValidator,
  StageValidator,
} from './types.js';
import { DocumentVersionError } from './types.js';
import { assertWritableCoursePlan, migrateCoursePlan } from './course-plan.js';

export interface HttpDocumentHeadersContext {
  method: string;
  path: string;
}

export type HttpDocumentHeadersHook = (
  context: HttpDocumentHeadersContext,
) => HeadersInit | Promise<HeadersInit>;

export interface HttpDocumentStoreOptions {
  /** Root URL before the contract's `/documents/...` paths. */
  baseUrl: string;
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Called for every request so deployments can attach authentication headers. */
  headers?: HttpDocumentHeadersHook;
  /** Client-side scene validator. Defaults to the DSL validator. */
  validateScene?: SceneValidator;
  /** Client-side stage validator. Defaults to the DSL validator. */
  validateStage?: StageValidator;
}

interface ErrorResponseBody {
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

interface DocumentVersionErrorDetails {
  storedVersion?: unknown;
}

/** A server-side DocumentStore failure, retaining its machine-readable HTTP identity. */
export class HttpDocumentStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpDocumentStoreError';
  }
}

function assertAddressableSegment(value: string): void {
  if (value === '.' || value === '..') {
    throw new Error(`@livecourse/storage: URL path segment must not be ${JSON.stringify(value)}`);
  }
}

function segment(value: string): string {
  assertAddressableSegment(value);
  return encodeURIComponent(value);
}

function assertValid(result: ReturnType<StageValidator>, label: string): void {
  if (result.valid) return;
  const detail = result.errors.map((error) => `${error.path || '/'}: ${error.message}`).join('; ');
  throw new Error(`@livecourse/storage: invalid ${label}: ${detail}`);
}

function assertStorableScene(scene: SceneLike, stageId: string): void {
  const value = scene as { id: unknown; stageId: unknown; order: unknown };
  if (typeof value.id !== 'string') {
    throw new Error(
      `@livecourse/storage: scene id must be a string, got ${JSON.stringify(value.id)}`,
    );
  }
  if (value.stageId !== stageId) {
    throw new Error(
      `@livecourse/storage: scene ${JSON.stringify(value.id)} has stageId ` +
        `${JSON.stringify(value.stageId)} but belongs to document ${JSON.stringify(stageId)}`,
    );
  }
  if (typeof value.order !== 'number' || !Number.isFinite(value.order)) {
    throw new Error(
      `@livecourse/storage: scene ${JSON.stringify(value.id)} order must be a finite number, got ` +
        `${JSON.stringify(value.order)}`,
    );
  }
}

function normalizeHeaders(init: HeadersInit | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  const set = (name: string, value: string): void => {
    normalized[name.toLowerCase()] = value;
  };
  if (init === undefined) return normalized;
  if (Array.isArray(init)) {
    for (const [name, value] of init) set(name, value);
  } else if (typeof (init as Headers).forEach === 'function') {
    (init as Headers).forEach((value, name) => set(name, value));
  } else {
    for (const [name, value] of Object.entries(init)) set(name, value);
  }
  return normalized;
}

function migrateDocument<TScene extends SceneLike, TStage extends Stage>(
  document: LiveCourseDocument<TScene, TStage>,
): LiveCourseDocument<TScene, TStage> {
  const { outline, coursePlan, ...core } = document;
  const migrated = migrate(core) as LiveCourseDocument<TScene, TStage>;
  const result = outline === undefined ? migrated : { ...migrated, outline };
  if (coursePlan !== undefined)
    result.coursePlan = migrateCoursePlan(coursePlan, document.stage.id);
  return result;
}

export class HttpDocumentStore<
  TScene extends SceneLike = Scene,
  TStage extends Stage = Stage,
> implements DocumentStore<TScene, TStage> {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headersHook: HttpDocumentHeadersHook | undefined;
  private readonly validateSceneFn: SceneValidator;
  private readonly validateStageFn: StageValidator;

  constructor(options: HttpDocumentStoreOptions) {
    if (options.baseUrl === '') {
      throw new Error('@livecourse/storage: HttpDocumentStore baseUrl must be non-empty');
    }
    // Bind explicitly: browsers require fetch to be invoked with `this === globalThis`
    // (calling a stored reference as `this.fetchImpl(...)` throws "Illegal
    // invocation"), while node's undici does not care — which is exactly why
    // node-only test suites cannot catch the unbound form.
    // Validate BEFORE binding: .bind on a non-function throws a native
    // TypeError that would preempt the documented error below.
    const selectedFetch = options.fetch ?? globalThis.fetch;
    if (typeof selectedFetch !== 'function') {
      throw new Error('@livecourse/storage: HttpDocumentStore requires a fetch implementation');
    }
    const fetchImpl = selectedFetch.bind(globalThis);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.headersHook = options.headers;
    this.validateSceneFn = options.validateScene ?? validateScene;
    this.validateStageFn = options.validateStage ?? validateStage;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    versionErrorStageId?: string,
  ): Promise<T> {
    const headers = normalizeHeaders(await this.headersHook?.({ method, path }));
    let serializedBody: string | undefined;
    if (body !== undefined) {
      headers['content-type'] ??= 'application/json';
      serializedBody = JSON.stringify(body);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
    });
    if (!response.ok) {
      let errorBody: ErrorResponseBody | undefined;
      try {
        errorBody = (await response.json()) as ErrorResponseBody;
      } catch {
        // Preserve a useful typed error even for a non-conforming server.
      }
      const code = typeof errorBody?.error?.code === 'string' ? errorBody.error.code : 'HTTP_ERROR';
      const message =
        typeof errorBody?.error?.message === 'string'
          ? errorBody.error.message
          : `@livecourse/storage: DocumentStore HTTP request failed with status ${response.status}`;
      if (
        response.status === 409 &&
        code === 'FUTURE_VERSION' &&
        versionErrorStageId !== undefined
      ) {
        const details = errorBody?.error?.details as DocumentVersionErrorDetails | undefined;
        const storedVersion =
          typeof details?.storedVersion === 'string' ? details.storedVersion : undefined;
        throw new DocumentVersionError(versionErrorStageId, 'future', storedVersion, message);
      }
      throw new HttpDocumentStoreError(response.status, code, message, errorBody?.error?.details);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private validateSceneForWrite(stageId: string, scene: TScene): void {
    assertValid(this.validateSceneFn(scene), `scene ${scene.id}`);
    assertStorableScene(scene, stageId);
  }

  async saveDocument(document: LiveCourseDocument<TScene, TStage>): Promise<void> {
    // The server repeats these checks. Running the injected gates here matches
    // BrowserDocumentStore's fail-fast boundary and avoids avoidable wire calls.
    if (document.coursePlan !== undefined) {
      assertWritableCoursePlan(document.coursePlan, document.stage.id);
    }
    const normalized = migrateDocument(document);
    assertValid(this.validateStageFn(normalized.stage), `stage ${normalized.stage.id}`);
    if (normalized.coursePlan !== undefined) {
      assertWritableCoursePlan(normalized.coursePlan, normalized.stage.id);
    }
    const seen = new Set<string>();
    for (const scene of normalized.scenes) {
      this.validateSceneForWrite(normalized.stage.id, scene);
      if (seen.has(scene.id)) {
        throw new Error(
          `@livecourse/storage: duplicate scene id ${JSON.stringify(scene.id)} in document ` +
            JSON.stringify(normalized.stage.id),
        );
      }
      seen.add(scene.id);
    }
    assertJsonValue(document, `document ${JSON.stringify(document.stage.id)}`);
    await this.request<void>(
      'PUT',
      `/documents/${segment(document.stage.id)}`,
      document,
      document.stage.id,
    );
  }

  async loadDocument(stageId: string): Promise<LiveCourseDocument<TScene, TStage> | null> {
    try {
      const document = await this.request<LiveCourseDocument<TScene, TStage>>(
        'GET',
        `/documents/${segment(stageId)}`,
      );
      return migrateDocument(document);
    } catch (error) {
      if (error instanceof HttpDocumentStoreError && error.code === 'DOCUMENT_NOT_FOUND') {
        return null;
      }
      throw error;
    }
  }

  async listDocuments(): Promise<DocumentSummary[]> {
    const summaries = await this.request<unknown>('GET', '/documents');
    if (!Array.isArray(summaries)) {
      throw new HttpDocumentStoreError(
        200,
        'MALFORMED_RESPONSE',
        '@livecourse/storage: DocumentStore HTTP listDocuments response must be an array',
      );
    }
    return summaries as DocumentSummary[];
  }

  async deleteDocument(stageId: string): Promise<void> {
    await this.request<void>('DELETE', `/documents/${segment(stageId)}`);
  }

  async putStage(stageId: string, stage: TStage): Promise<void> {
    assertValid(this.validateStageFn(stage), `stage ${stage.id}`);
    assertJsonValue(stage, `stage ${JSON.stringify(stage.id)}`);
    await this.request<void>('PUT', `/documents/${segment(stageId)}/stage`, stage, stageId);
  }

  async putScene(stageId: string, scene: TScene): Promise<void> {
    this.validateSceneForWrite(stageId, scene);
    assertJsonValue(scene, `scene ${JSON.stringify(scene.id)}`);
    await this.request<void>(
      'PUT',
      `/documents/${segment(stageId)}/scenes/${segment(scene.id)}`,
      scene,
      stageId,
    );
  }

  async getScene(stageId: string, sceneId: string): Promise<TScene | null> {
    try {
      return await this.request<TScene>(
        'GET',
        `/documents/${segment(stageId)}/scenes/${segment(sceneId)}`,
      );
    } catch (error) {
      if (
        error instanceof HttpDocumentStoreError &&
        (error.code === 'DOCUMENT_NOT_FOUND' || error.code === 'SCENE_NOT_FOUND')
      ) {
        return null;
      }
      throw error;
    }
  }

  async deleteScene(stageId: string, sceneId: string): Promise<void> {
    await this.request<void>(
      'DELETE',
      `/documents/${segment(stageId)}/scenes/${segment(sceneId)}`,
      undefined,
      stageId,
    );
  }
}
