/**
 * Stage API - AI Agent Toolkit
 *
 * Provides a complete Stage operation interface for AI Agents to create and manage course content
 *
 * Design Principles:
 * 1. Type Safety: Fully leverage TypeScript's type system
 * 2. Ease of Use: Provide high-level abstractions with clear, intuitive API naming
 * 3. Extensibility: Support adding new scene types in the future
 * 4. Idempotency: Multiple calls with the same parameters produce the same result
 * 5. Error Handling: Return explicit success/failure status and error messages
 *
 * @example
 * ```typescript
 * const api = createStageAPI(stageStore);
 *
 * // Create a new scene
 * const sceneId = api.scene.create({
 *   type: 'slide',
 *   title: 'Introduction',
 *   // speech is now in actions
 * });
 *
 * // Add an element
 * const elementId = api.element.add(sceneId, {
 *   type: 'text',
 *   content: 'Hello World',
 *   left: 100,
 *   top: 100
 * });
 *
 * // Highlight an element (teaching feature)
 * api.canvas.highlight(sceneId, elementId, 3000);
 * ```
 */

// Re-export all types
export type {
  APIResult,
  CreateSceneParams,
  CreateElementParams,
  HighlightOptions,
  SpotlightOptions,
  StageStore,
} from './stage-api-types';

// Re-export utility functions that were previously accessible
export {
  generateId,
  validateSceneId,
  getScene,
  createDefaultContent,
  createDefaultSlideContent,
  createDefaultQuizContent,
  createDefaultInteractiveContent,
  createDefaultPBLContent,
} from './stage-api-defaults';

// Import sub-API factories
import { createSceneAPI } from './stage-api-scene';
import { createElementAPI } from './stage-api-element';
import {
  createCanvasAPI,
  createCanvasPresentationOwner,
  captureCanvasPresentationSnapshot as captureCanvasOverlaySnapshot,
  type CanvasPresentationOwner,
  type CanvasPresentationSnapshot,
} from './stage-api-canvas';
import { createNavigationAPI } from './stage-api-navigation';
import { createWhiteboardAPI } from './stage-api-whiteboard';
import { createModeAPI, createStageMetaAPI } from './stage-api-mode';
import type { APIResult, StageStore } from './stage-api-types';
import {
  acquireStagePresentationFence,
  markStagePersistenceDirty,
  useStageStore,
  type StagePresentationFence,
} from '@/lib/store/stage';
import type { PendingChange } from '@/lib/utils/stage-storage';
import type { PPTElement } from '@livecourse/dsl';
import { isPPTElementType } from '@livecourse/dsl';
import type { TeachingAction } from '@/lib/livecourse/domain';

function persistenceChangesForSetState(
  before: ReturnType<StageStore['getState']>,
  after: ReturnType<StageStore['getState']>,
): PendingChange[] {
  const changes: PendingChange[] = [];

  if (before.stage !== after.stage) changes.push({ kind: 'stage' });
  if (before.currentSceneId !== after.currentSceneId) changes.push({ kind: 'currentScene' });

  if (before.scenes !== after.scenes) {
    const beforeStructure = before.scenes.map(({ id, order }) => [id, order] as const);
    const afterStructure = after.scenes.map(({ id, order }) => [id, order] as const);
    const structureChanged =
      beforeStructure.length !== afterStructure.length ||
      beforeStructure.some(
        ([id, order], index) =>
          afterStructure[index]?.[0] !== id || afterStructure[index]?.[1] !== order,
      );

    if (structureChanged) {
      changes.push({ kind: 'structure' });
    } else {
      before.scenes.forEach((scene, index) => {
        if (scene !== after.scenes[index]) changes.push({ kind: 'scene', sceneId: scene.id });
      });
    }
  }

  return changes;
}

function withProductionPersistence(store: StageStore): StageStore {
  if (store !== useStageStore) return store;
  return {
    ...store,
    setState(partial) {
      const before = store.getState();
      store.setState(partial);
      const changes = persistenceChangesForSetState(before, store.getState());
      if (changes.length > 0) markStagePersistenceDirty(changes);
    },
  };
}

// ==================== Stage API Implementation ====================

/**
 * Create a Stage API instance
 *
 * @param store - Zustand store instance
 * @returns Stage API object
 */
export function createStageAPI(store: StageStore, options: StageAPIOptions = {}) {
  // All namespaces receive the same guarded injection boundary. New API
  // modules cannot bypass persistence by adding another raw setState call.
  const persistenceStore = withProductionPersistence(store);
  const inferredPresentationOwner = (store as Partial<StagePresentationStore>).presentation?.canvas;
  const presentationOwner = options.presentationOwner ?? inferredPresentationOwner;
  return {
    scene: createSceneAPI(persistenceStore),
    navigation: createNavigationAPI(persistenceStore),
    element: createElementAPI(persistenceStore),
    // Keep the no-options call as the ordinary production path.  A
    // presentation adapter opts into its owner only when one is actually
    // present, preserving the factory's legacy invocation contract.
    canvas: presentationOwner
      ? createCanvasAPI(persistenceStore, { presentationOwner })
      : createCanvasAPI(persistenceStore),
    whiteboard: createWhiteboardAPI(persistenceStore),
    mode: createModeAPI(persistenceStore),
    stage: createStageMetaAPI(persistenceStore),
  };
}

type PresentationState = ReturnType<StageStore['getState']>;
type PresentationStateKey = keyof PresentationState;

/** Detached snapshot of the canonical Stage fields used for presentation. */
export type StagePresentationSnapshot = {
  stage: PresentationState['stage'];
  scenes: PresentationState['scenes'];
  currentSceneId: PresentationState['currentSceneId'];
  mode: PresentationState['mode'];
};

/** Complete teaching presentation image (Stage + teaching-only Canvas overlay). */
export interface TeachingPresentationSnapshot {
  stage: StagePresentationSnapshot;
  canvas: CanvasPresentationSnapshot;
}

const PRESENTATION_STATE_KEYS: readonly PresentationStateKey[] = [
  'stage',
  'scenes',
  'currentSceneId',
  'mode',
];

function clonePresentationState(state: PresentationState): StagePresentationSnapshot {
  // Stage/scene data is JSON-shaped. A detached clone is important here: the
  // canonical store can be changed repeatedly while replay runs, and the
  // restore journal must retain the values that existed before the first
  // presentation mutation.
  return {
    stage: state.stage ? structuredClone(state.stage) : null,
    scenes: structuredClone(state.scenes),
    currentSceneId: state.currentSceneId,
    mode: state.mode,
  };
}

export function captureStagePresentationSnapshot(
  store: StageStore = useStageStore,
): StagePresentationSnapshot {
  return clonePresentationState(store.getState());
}

export function captureCanvasPresentationSnapshot(): CanvasPresentationSnapshot {
  return captureCanvasOverlaySnapshot();
}

export function captureTeachingPresentationSnapshot(
  store: StageStore = useStageStore,
  canvasOwner?: CanvasPresentationOwner,
): TeachingPresentationSnapshot {
  return {
    stage: captureStagePresentationSnapshot(store),
    canvas: canvasOwner ? canvasOwner.capture() : captureCanvasPresentationSnapshot(),
  };
}

function presentationValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function throwPresentationErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

export interface StagePresentationStore extends StageStore {
  /**
   * Lifecycle controls for the temporary canonical-store projection. Calling
   * `dispose()` restores journaled fields (when they still contain the values
   * this adapter wrote) and releases its nestable persistence fence.
   */
  readonly presentation: {
    /** Capture a detached image of the presentation-owned Stage fields. */
    capture: () => StagePresentationSnapshot;
    /** Restore a detached image without adding persistence dirt. */
    restoreSnapshot: (snapshot: StagePresentationSnapshot) => void;
    /** Restore only if all presentation fields still equal `expected`. */
    restoreIfCurrent: (
      before: StagePresentationSnapshot,
      expected: StagePresentationSnapshot,
    ) => boolean;
    restore: () => void;
    dispose: () => void;
    isDisposed: () => boolean;
    /** Timer/snapshot owner for teaching-only Canvas overlays. */
    canvas: CanvasPresentationOwner;
    fence: StagePresentationFence;
  };
}

export interface StagePresentationStoreOptions {
  /**
   * Acquire a document-persistence fence for this adapter. React render paths
   * that may be abandoned (for example the top-level Stage `useMemo`) should
   * pass `'lazy'` for render-created adapters: the lease is acquired
   * synchronously immediately before the first presentation mutation, avoiding
   * a leaked lease if a concurrent render is abandoned while still protecting
   * the mutation itself.
   * Defaults to `true` for imperative callers such as ReplayHost.
   */
  readonly fence?: boolean | 'lazy';
}

export interface StageAPIOptions {
  /** Optional Canvas owner used to isolate action timers and compensation. */
  readonly presentationOwner?: CanvasPresentationOwner;
}

/**
 * Return a presentation-only adapter over the canonical stage state.
 *
 * Playback/replay needs to share the live canvas and subscriptions, while
 * navigation and teaching effects must not enter the document persistence
 * scheduler. `createStageAPI` only adds its persistence wrapper for the
 * canonical `useStageStore` identity, so this intentionally distinct adapter
 * keeps those visual writes in memory.
 */
export function createStagePresentationStore(
  options: StagePresentationStoreOptions = {},
): StagePresentationStore {
  const shouldAcquireFence = options.fence !== false;
  // A render-created adapter can outlive the render that created it before
  // its first presentation write (for example while the classroom document
  // is still loading). Keep the lease and the journal independent: the lease
  // may be acquired eagerly, but the restore baseline is captured only at the
  // first effective presentation mutation.
  let activeFence: StagePresentationFence | null = shouldAcquireFence
    ? options.fence === 'lazy'
      ? null
      : acquireStagePresentationFence()
    : null;
  const ensureFence = () => {
    if (shouldAcquireFence) activeFence ??= acquireStagePresentationFence();
    return activeFence;
  };
  const releaseFence = () => {
    activeFence?.release();
    activeFence = null;
  };
  type PresentationJournal = {
    initial: StagePresentationSnapshot;
    expected: StagePresentationSnapshot;
  };
  let journal: PresentationJournal | null = null;
  const touched = new Set<PresentationStateKey>();
  let disposed = false;
  const canvasPresentation = createCanvasPresentationOwner();

  const captureJournal = (baseline: StagePresentationSnapshot) => {
    journal = {
      initial: baseline,
      expected: structuredClone(baseline),
    };
  };

  const recordJournalDelta = (
    before: StagePresentationSnapshot,
    after: StagePresentationSnapshot,
    keys: Iterable<PresentationStateKey> = PRESENTATION_STATE_KEYS,
  ): void => {
    if (!journal) return;
    for (const key of keys) {
      if (!presentationValueEqual(before[key], after[key])) {
        touched.add(key);
        journal.expected[key] = structuredClone(after[key]) as never;
      }
    }
  };

  const capture = (): StagePresentationSnapshot => clonePresentationState(useStageStore.getState());

  const writeSnapshot = (snapshot: StagePresentationSnapshot): void => {
    if (disposed) throw new Error('Presentation store has been disposed');
    const current = capture();
    const patch: Partial<PresentationState> = {};
    for (const key of PRESENTATION_STATE_KEYS) {
      if (!presentationValueEqual(current[key], snapshot[key])) {
        patch[key] = structuredClone(snapshot[key]) as never;
      }
    }
    if (Object.keys(patch).length === 0) return;
    // Public snapshot writes are presentation mutations too. Capture a
    // baseline/fence when this is the first write so a caller that restores a
    // detached image directly still gets the same cleanup guarantees as
    // `setState`/the action applier.
    if (!journal) captureJournal(current);
    ensureFence();

    let writeError: unknown;
    try {
      useStageStore.setState(patch);
    } catch (cause) {
      // Zustand listeners can throw after a state write. Re-read the store and
      // journal the actually visible image before surfacing that error, so a
      // later dispose can compensate a partial mutation.
      writeError = cause;
    }
    const after = capture();
    recordJournalDelta(current, after, Object.keys(patch) as PresentationStateKey[]);
    if (writeError) throw writeError;
  };

  const restoreSnapshot = (snapshot: StagePresentationSnapshot): void => {
    writeSnapshot(snapshot);
  };

  const restoreIfCurrent = (
    before: StagePresentationSnapshot,
    expected: StagePresentationSnapshot,
  ): boolean => {
    if (disposed) throw new Error('Presentation store has been disposed');
    const current = capture();
    if (
      !PRESENTATION_STATE_KEYS.every((key) => presentationValueEqual(current[key], expected[key]))
    ) {
      return false;
    }
    restoreSnapshot(before);
    return true;
  };

  const restoreStage = () => {
    if (disposed) return;

    if (touched.size > 0 && journal) {
      const current = useStageStore.getState();
      const patch: Partial<PresentationState> = {};
      for (const key of touched) {
        // Do not clobber an unrelated writer that changed the field after this
        // adapter's last presentation write. Replay owns only its journaled
        // values; a live route transition may legitimately win the race.
        if (!presentationValueEqual(current[key], journal.expected[key])) continue;
        patch[key] = structuredClone(journal.initial[key]) as never;
      }
      if (Object.keys(patch).length > 0) useStageStore.setState(patch);

      // A shared boundary may host more than one replay attempt (for example
      // a failed start followed by Retry). Drop the old journal so a later
      // attempt captures whatever canonical state exists immediately before
      // its first effective presentation mutation.
      journal = null;
      touched.clear();
    }
  };

  const restore = () => {
    if (disposed) return;
    const errors: unknown[] = [];
    // Canvas and Stage are separate Zustand stores.  Attempt both restores even
    // when one side throws so a transient subscriber failure cannot strand a
    // half-restored projection or leave the stage fence held forever.
    try {
      canvasPresentation.restoreBaseline();
    } catch (cause) {
      errors.push(cause);
    }
    try {
      restoreStage();
    } catch (cause) {
      errors.push(cause);
    }
    throwPresentationErrors(errors, 'Presentation restore failed');
  };

  const dispose = () => {
    if (disposed) return;
    const errors: unknown[] = [];
    // Restore before releasing the outermost fence. The release callback may
    // schedule a pending flush in a microtask, which must observe restored data.
    try {
      restore();
    } catch (cause) {
      errors.push(cause);
    }
    // `restore()` already attempts the baseline restore, but dispose still has
    // to cancel timers and mark the Canvas owner dead when that attempt failed.
    try {
      canvasPresentation.dispose();
    } catch (cause) {
      errors.push(cause);
    }
    disposed = true;
    try {
      releaseFence();
    } catch (cause) {
      errors.push(cause);
    }
    throwPresentationErrors(errors, 'Presentation dispose failed');
  };

  const store: StagePresentationStore = {
    getState: () => useStageStore.getState(),
    setState: (partial) => {
      if (disposed) throw new Error('Presentation store has been disposed');

      // Resolve updater functions once against the current state. Besides
      // preserving Zustand's updater semantics, this lets a lazy adapter
      // distinguish an effective presentation mutation from a no-op before it
      // acquires a persistence fence. A render-created adapter may be
      // abandoned without ever mutating the canonical store; such an adapter
      // must not leave a lease behind merely because a consumer wrote the
      // value it already had.
      const currentState = useStageStore.getState();
      const before = clonePresentationState(currentState);
      const nextPartial = typeof partial === 'function' ? partial(currentState) : partial;
      if (nextPartial === null || nextPartial === undefined) return;

      const projectedState = { ...currentState, ...nextPartial };
      const changedKeys = PRESENTATION_STATE_KEYS.filter(
        (key) => !presentationValueEqual(before[key], projectedState[key]),
      );

      // Preserve ordinary Zustand updates that do not touch presentation
      // fields, but do not acquire a lease for them (or for an effective
      // no-op). StageStore's public surface only exposes the four fields above;
      // this branch keeps the adapter well-behaved if an internal caller adds
      // a transient field later.
      if (changedKeys.length === 0) {
        useStageStore.setState(nextPartial);
        return;
      }

      // Capture the baseline before the raw write. A store implementation may
      // synchronously notify listeners or throw after a partial mutation; the
      // compensation path must still have the pre-image available.
      if (!journal) captureJournal(before);

      // Lazy adapters (used by render-created Stage surfaces) acquire the
      // fence at the last safe synchronous boundary, immediately before their
      // first canonical mutation.
      ensureFence();
      let writeError: unknown;
      try {
        useStageStore.setState(nextPartial);
      } catch (cause) {
        // Preserve the explicit failure while still recording a potentially
        // partial canonical write for compare-and-set cleanup.
        writeError = cause;
      }
      const after = clonePresentationState(useStageStore.getState());
      recordJournalDelta(before, after, changedKeys);
      if (writeError) throw writeError;
    },
    subscribe: (listener) => useStageStore.subscribe(listener),
    presentation: {
      capture,
      restoreSnapshot,
      restoreIfCurrent,
      restore,
      dispose,
      isDisposed: () => disposed,
      canvas: canvasPresentation,
      fence: { release: releaseFence },
    },
  };
  return store;
}

function asPresentationElement(value: Record<string, unknown> | undefined): PPTElement | undefined {
  if (!value || !isPPTElementType(value.type)) return undefined;
  const numericFields = ['left', 'top', 'width', 'height'] as const;
  if (numericFields.some((field) => typeof value[field] !== 'number')) return undefined;
  if (value.id !== undefined && typeof value.id !== 'string') return undefined;
  return value as unknown as PPTElement;
}

function handledResult(result: APIResult<boolean>): APIResult<{ handled: true }> {
  return result.success
    ? { success: true, data: { handled: true } }
    : { success: false, error: result.error };
}

export function applyLiveCourseTeachingAction(
  action: TeachingAction,
  store: StageStore = useStageStore,
  options: { resolveNodeSceneId?: (nodeId: string) => string | undefined } = {},
): APIResult<{ handled: boolean }> {
  const api = createStageAPI(store);

  switch (action.type) {
    case 'lesson.goto_node': {
      const sceneId = options.resolveNodeSceneId?.(action.payload.targetNodeId);
      return sceneId
        ? handledResult(api.navigation.goTo(sceneId))
        : { success: false, error: `Lesson node not found: ${action.payload.targetNodeId}` };
    }
    // J3.2 插话恢复 / J3.6 课中重听进出：导航语义与 goto_node 相同，
    // 状态合法性已由课堂控制器门禁校验，这里只负责画面跳转。
    case 'lesson.resume_interrupted':
    case 'lesson.relisten_start':
    case 'lesson.relisten_end': {
      const sceneId = options.resolveNodeSceneId?.(action.payload.targetNodeId);
      return sceneId
        ? handledResult(api.navigation.goTo(sceneId))
        : { success: false, error: `Lesson node not found: ${action.payload.targetNodeId}` };
    }
    case 'stage.goto_scene':
      return handledResult(api.navigation.goTo(action.payload.sceneId));
    case 'stage.highlight':
      return handledResult(
        api.canvas.highlight(action.payload.sceneId, action.payload.elementId, {
          duration: action.payload.durationMs,
          color: action.payload.color,
          style: action.payload.style,
        }),
      );
    case 'stage.pointer': {
      if (!action.payload.elementId) {
        return { success: false, error: 'stage.pointer currently requires elementId' };
      }
      const x = (action.payload.x ?? 0.5) * 100;
      const y = (action.payload.y ?? 0.5) * 100;
      return handledResult(
        api.canvas.setLaser(
          action.payload.sceneId,
          action.payload.elementId,
          { x, y, w: 0, h: 0, centerX: x, centerY: y },
          { duration: action.payload.durationMs },
        ),
      );
    }
    case 'board.clear': {
      const boards = store.getState().stage?.whiteboard ?? [];
      if (boards.length === 0) return { success: true, data: { handled: true } };
      const board = action.payload.whiteboardId
        ? boards.find((item) => item.id === action.payload.whiteboardId)
        : boards.at(-1);
      return board
        ? handledResult(api.whiteboard.update({ elements: [] }, board.id))
        : { success: false, error: `Whiteboard not found: ${action.payload.whiteboardId}` };
    }
    case 'board.apply': {
      const boards = store.getState().stage?.whiteboard ?? [];
      const board = action.payload.whiteboardId
        ? boards.find((item) => item.id === action.payload.whiteboardId)
        : boards.at(-1);
      if (!board) return { success: false, error: 'No whiteboard is available' };
      if (action.payload.operation === 'delete') {
        return action.payload.elementId
          ? handledResult(api.whiteboard.deleteElement(action.payload.elementId, board.id))
          : { success: false, error: 'board.apply delete requires elementId' };
      }
      const element = asPresentationElement(action.payload.element);
      if (!element) {
        return { success: false, error: 'board.apply requires a valid presentation element' };
      }
      return handledResult(
        action.payload.operation === 'add'
          ? api.whiteboard.addElement(element, board.id)
          : api.whiteboard.updateElement(element, board.id),
      );
    }
    default:
      return { success: true, data: { handled: false } };
  }
}

// ==================== Type Exports ====================

export type StageAPI = ReturnType<typeof createStageAPI>;
