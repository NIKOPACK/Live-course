/**
 * ActionEngine — Unified execution layer for all agent actions.
 *
 * Replaces the 28 Vercel AI SDK tools in ai-tools.ts with a single engine
 * that both online (streaming) and offline (playback) paths share.
 *
 * Two execution modes:
 * - Fire-and-forget: spotlight, laser — dispatch and return immediately
 * - Synchronous: speech, whiteboard, discussion — await completion
 */

import type { StageStore } from '@/lib/api/stage-api';
import { createStageAPI } from '@/lib/api/stage-api';
import type {
  CanvasPresentationChannelKind,
  CanvasPresentationOwner,
} from '@/lib/api/stage-api-canvas';
import { useCanvasStore } from '@/lib/store/canvas';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { useMediaGenerationStore, type MediaTask } from '@/lib/store/media-generation';
import type { AudioPlayer } from '@/lib/utils/audio-player';
import type {
  Action,
  SpotlightAction,
  LaserAction,
  SpeechAction,
  PlayVideoAction,
  WbDrawTextAction,
  WbDrawShapeAction,
  WbDrawChartAction,
  WbDrawLatexAction,
  WbDrawTableAction,
  WbDeleteAction,
  WbDrawLineAction,
  WbDrawCodeAction,
  WbEditCodeAction,
  WidgetHighlightAction,
  WidgetSetStateAction,
  WidgetAnnotationAction,
  WidgetRevealAction,
} from '@/lib/types/action';
import type { CodeLine, PPTVideoElement } from '@livecourse/dsl';
import {
  resolveVideoMediaForElement,
  type VideoMediaTaskResolution,
} from '@/lib/media/media-task-resolution';
import {
  EFFECT_AUTO_CLEAR_MS,
  MAX_VIDEO_WAIT_MS,
  WB_OPEN_MS,
  WB_DRAW_MS,
  WB_EDIT_MS,
  WB_DELETE_MS,
  WB_CLOSE_MS,
  WIDGET_MS,
  wbDrawCodeMs,
  wbClearMs,
} from '@/lib/choreography';
import katex from 'katex';
import { createLogger } from '@/lib/logger';

const log = createLogger('ActionEngine');

// ==================== SVG Paths for Shapes ====================

const SHAPE_PATHS: Record<string, string> = {
  rectangle: 'M 0 0 L 1000 0 L 1000 1000 L 0 1000 Z',
  circle: 'M 500 0 A 500 500 0 1 1 499 0 Z',
  triangle: 'M 500 0 L 1000 1000 L 0 1000 Z',
};

// ==================== Helpers ====================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for an animation while allowing the owner to invalidate it. Resolving
 * with `false` (rather than rejecting) keeps cancellation a normal lifecycle
 * transition; callers still check the signal before every state mutation.
 */
function delayWithSignal(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return delay(ms).then(() => true);
  if (signal.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const COMMON_LATEX_COMMAND =
  /\\(?:alpha|beta|cdot|delta|dfrac|frac|gamma|infty|int|lambda|left|lim|mu|neq|omega|pi|pm|prod|rightarrow|right|sigma|sqrt|sum|text|tfrac|theta|times)\b/;

function getDelimitedLatex(content: string): string | null {
  const trimmed = content.trim();

  if (trimmed.length > 4 && trimmed.startsWith('$$') && trimmed.endsWith('$$')) {
    return trimmed.slice(2, -2).trim();
  }
  if (
    trimmed.length > 2 &&
    trimmed.startsWith('$') &&
    trimmed.endsWith('$') &&
    !trimmed.startsWith('$$') &&
    !trimmed.endsWith('$$')
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return null;
}

function getLikelyLatexMath(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.startsWith('<')) return null;

  const delimitedLatex = getDelimitedLatex(trimmed);
  if (delimitedLatex !== null) return delimitedLatex;
  if (/^[A-Za-z]:\\/.test(trimmed)) return null;
  if (COMMON_LATEX_COMMAND.test(trimmed) || /[_^]\{/.test(trimmed)) return trimmed;

  const commands = trimmed.match(/\\[A-Za-z]+/g) ?? [];
  if (commands.length === 0) return null;
  if (commands.length === 1) {
    return /\\[A-Za-z]+\s*\{[^{}]*\}/.test(trimmed) ? trimmed : null;
  }
  if (!/[=+\-*/^_{}]/.test(trimmed)) return null;

  const commandCharacters = commands.reduce((total, command) => total + command.length, 0);
  return commandCharacters / trimmed.length >= 0.15 ? trimmed : null;
}

/** Convert raw code string to CodeLine array with unique IDs */
function codeToLines(code: string): CodeLine[] {
  return code.split('\n').map((content, i) => ({
    id: `L${i + 1}`,
    content,
  }));
}

let lineIdCounter = 0;
/** Generate unique line IDs for newly inserted lines */
function generateLineIds(count: number): string[] {
  return Array.from({ length: count }, () => `L_${++lineIdCounter}_${Date.now().toString(36)}`);
}

/** Resolve the video element and its renderer-equivalent media binding for an action. */
export function resolveActionVideoMedia(
  stageStore: StageStore,
  tasks: Readonly<Record<string, MediaTask>>,
  elementId: string,
): VideoMediaTaskResolution<MediaTask> | undefined {
  const { stage, scenes, currentSceneId } = stageStore.getState();
  const orderedScenes = currentSceneId
    ? [
        scenes.find((scene) => scene.id === currentSceneId),
        ...scenes.filter((scene) => scene.id !== currentSceneId),
      ]
    : scenes;

  for (const scene of orderedScenes) {
    if (!scene || scene.content.type !== 'slide') continue;
    const element = scene.content.canvas.elements.find(
      (candidate): candidate is PPTVideoElement =>
        candidate.id === elementId && candidate.type === 'video',
    );
    if (element) return resolveVideoMediaForElement(tasks, element, stage?.id);
  }
  return undefined;
}

// ==================== ActionEngine ====================

/** Callback for sending messages to widget iframe */
export type WidgetMessageCallback = (
  type: string,
  payload: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => void | Promise<void>;

export interface ActionExecutionOptions {
  silent?: boolean;
  signal?: AbortSignal;
}

/**
 * A presentation adapter exposes its Canvas owner alongside the Stage store.
 * Keep this structural type local so ActionEngine remains usable with the
 * ordinary editor/session StageStore implementations.
 */
type PresentationAwareStageStore = StageStore & {
  presentation?: {
    canvas?: CanvasPresentationOwner;
    isDisposed?: () => boolean;
  };
};

const CANVAS_EFFECT_CHANNELS: readonly CanvasPresentationChannelKind[] = [
  'highlight',
  'spotlight',
  'laser',
  'zoom',
];

/**
 * A Stage presentation may create more than one ActionEngine over the same
 * store while a replay is being replaced.  Canvas channels have their own
 * claims, but Stage whiteboard data does not; keep a lease at the engine
 * boundary so the newest engine invalidates every delayed callback and direct
 * whiteboard mutation issued by an older one.
 */
let nextActionEngineLeaseGeneration = 1;
const actionEngineLeases = new WeakMap<object, number>();

function acquireActionEngineLease(owner: CanvasPresentationOwner): number {
  const generation = nextActionEngineLeaseGeneration++;
  actionEngineLeases.set(owner, generation);
  return generation;
}

export class ActionEngine {
  private stageStore: StageStore;
  private stageAPI: ReturnType<typeof createStageAPI>;
  private audioPlayer: AudioPlayer | null;
  /**
   * Replay/teaching surfaces attach a transactional Canvas owner to their
   * presentation Stage store. Ordinary editor/session stores leave this
   * unset and retain the historical direct Canvas behaviour.
   */
  private readonly presentationOwner: CanvasPresentationOwner | null;
  /** Optional Stage presentation lifecycle probe for owner-first teardown. */
  private readonly presentationIsDisposed: (() => boolean) | null;
  /** Generation held by this engine in the shared presentation lease. */
  private readonly presentationLeaseGeneration: number | null;
  /** Latest claim generation held by this engine for each Canvas channel. */
  private readonly canvasClaimGenerations = new Map<CanvasPresentationChannelKind, number>();
  private effectTimer: ReturnType<typeof setTimeout> | null = null;
  private widgetMessageCallback: WidgetMessageCallback | null = null;
  /** Invalidates delayed whiteboard mutations when playback is stopped. */
  private whiteboardClearGeneration = 0;
  /** Once disposed, this engine cannot issue any further mutations. */
  private disposed = false;

  constructor(
    stageStore: StageStore,
    audioPlayer?: AudioPlayer | null,
    widgetMessageCallback?: WidgetMessageCallback | null,
    presentationOwner?: CanvasPresentationOwner | null,
  ) {
    this.stageStore = stageStore;
    const presentation = stageStore as PresentationAwareStageStore;
    this.presentationOwner =
      presentationOwner === undefined
        ? (presentation.presentation?.canvas ?? null)
        : presentationOwner;
    this.presentationIsDisposed = presentation.presentation?.isDisposed ?? null;
    this.presentationLeaseGeneration = this.presentationOwner
      ? acquireActionEngineLease(this.presentationOwner)
      : null;
    this.stageAPI = createStageAPI(
      stageStore,
      this.presentationOwner ? { presentationOwner: this.presentationOwner } : {},
    );
    this.audioPlayer = audioPlayer ?? null;
    this.widgetMessageCallback = widgetMessageCallback ?? null;
  }

  /** Whether this engine is still the active writer for its presentation. */
  private isCurrentPresentationLease(): boolean {
    if (this.disposed) return false;
    if (this.presentationIsDisposed?.()) return false;
    if (!this.presentationOwner) return true;
    return actionEngineLeases.get(this.presentationOwner) === this.presentationLeaseGeneration;
  }

  /**
   * Run a synchronous Canvas mutation under the presentation owner's journal.
   * Claiming is intentionally done immediately before the raw Zustand write;
   * an older replay owner can therefore be invalidated by a newer owner while
   * all writes from this engine still have one consistent seam.
   */
  private mutateCanvas<T>(
    kinds: readonly CanvasPresentationChannelKind[],
    mutation: () => T,
  ): T | undefined {
    if (!this.isCurrentPresentationLease()) return undefined;
    const owner = this.presentationOwner;
    if (!owner) return mutation();

    owner.beginMutation();
    try {
      for (const kind of kinds) {
        this.canvasClaimGenerations.set(kind, owner.claim(kind));
      }
      return mutation();
    } finally {
      owner.endMutation();
    }
  }

  /** Claim a channel before an asynchronous action starts waiting. */
  private claimCanvasChannel(kind: CanvasPresentationChannelKind): number | undefined {
    if (!this.isCurrentPresentationLease()) return undefined;
    const owner = this.presentationOwner;
    if (!owner) return undefined;

    owner.beginMutation();
    try {
      const generation = owner.claim(kind);
      this.canvasClaimGenerations.set(kind, generation);
      return generation;
    } finally {
      owner.endMutation();
    }
  }

  private isCurrentCanvasChannel(
    kind: CanvasPresentationChannelKind,
    generation?: number,
  ): boolean {
    if (!this.isCurrentPresentationLease()) return false;
    const owner = this.presentationOwner;
    if (!owner) return true;
    const token = generation ?? this.canvasClaimGenerations.get(kind);
    return token !== undefined && owner.isCurrent(kind, token);
  }

  /**
   * Mutate a channel only while this engine still owns its claim. This is the
   * stale-owner barrier used by abort/timeout/cleanup callbacks: an old replay
   * must not pause or close state projected by a newer replay.
   */
  private mutateCurrentCanvas<T>(
    kind: CanvasPresentationChannelKind,
    mutation: () => T,
  ): T | undefined {
    if (!this.isCurrentPresentationLease()) return undefined;
    const owner = this.presentationOwner;
    if (!owner) return mutation();

    const generation = this.canvasClaimGenerations.get(kind);
    if (generation === undefined || !owner.isCurrent(kind, generation)) return undefined;

    owner.beginMutation();
    try {
      if (!owner.isCurrent(kind, generation)) return undefined;
      this.canvasClaimGenerations.set(kind, owner.claim(kind));
      return mutation();
    } finally {
      owner.endMutation();
    }
  }

  /** Refresh the owner's expected image after a renderer-side state change. */
  private syncCurrentCanvasChannel(kind: CanvasPresentationChannelKind): void {
    if (!this.isCurrentPresentationLease()) return;
    const owner = this.presentationOwner;
    if (!owner) return;
    const generation = this.canvasClaimGenerations.get(kind);
    if (generation === undefined || !owner.isCurrent(kind, generation)) return;

    owner.beginMutation();
    // No asynchronous boundary exists between the ownership check and this
    // bookkeeping call. If teardown has already disposed the owner,
    // propagating that error keeps the lifecycle failure visible to callers.
    if (owner.isCurrent(kind, generation)) owner.endMutation();
  }

  /** Clear only channels still owned by this engine. */
  private clearCurrentCanvasChannels(kinds: readonly CanvasPresentationChannelKind[]): void {
    if (!this.isCurrentPresentationLease()) return;
    const owner = this.presentationOwner;
    if (!owner) {
      useCanvasStore.getState().clearAllEffects();
      return;
    }

    const currentKinds = kinds.filter((kind) => {
      const generation = this.canvasClaimGenerations.get(kind);
      return generation !== undefined && owner.isCurrent(kind, generation);
    });
    if (currentKinds.length === 0) return;

    owner.beginMutation();
    try {
      for (const kind of currentKinds) {
        const generation = this.canvasClaimGenerations.get(kind);
        if (generation === undefined || !owner.isCurrent(kind, generation)) continue;
        this.canvasClaimGenerations.set(kind, owner.claim(kind));
        switch (kind) {
          case 'highlight':
            useCanvasStore.getState().clearHighlight();
            break;
          case 'spotlight':
            useCanvasStore.getState().clearSpotlight();
            break;
          case 'laser':
            useCanvasStore.getState().clearLaser();
            break;
          case 'zoom':
            useCanvasStore.getState().clearZoom();
            break;
          // ActionEngine currently owns these channels only through the
          // dedicated public helpers below; keep the switch exhaustive while
          // avoiding accidental clearing of them from clearEffects().
          case 'video':
            useCanvasStore.getState().pauseVideo();
            break;
          case 'whiteboard':
            useCanvasStore.getState().setWhiteboardOpen(false);
            useCanvasStore.getState().setWhiteboardClearing(false);
            break;
        }
      }
    } finally {
      owner.endMutation();
    }
  }

  /** Set a runtime Canvas channel while retaining its ownership token. */
  private setCurrentCanvasRuntime(kind: 'video' | 'whiteboard', mutation: () => void): void {
    this.mutateCurrentCanvas(kind, mutation);
  }

  /**
   * Dispose invalidates the engine before touching shared state. This narrowly
   * scoped cleanup therefore checks the previously captured channel claim
   * directly, allowing an owned animation flag to settle without reopening
   * the engine for arbitrary mutations.
   */
  private clearOwnedWhiteboardAnimationAfterDispose(): void {
    const owner = this.presentationOwner;
    if (!owner) {
      useCanvasStore.getState().setWhiteboardClearing(false);
      return;
    }

    const generation = this.canvasClaimGenerations.get('whiteboard');
    if (generation === undefined || !owner.isCurrent('whiteboard', generation)) return;

    owner.beginMutation();
    try {
      if (!owner.isCurrent('whiteboard', generation)) return;
      this.canvasClaimGenerations.set('whiteboard', owner.claim('whiteboard'));
      useCanvasStore.getState().setWhiteboardClearing(false);
    } finally {
      owner.endMutation();
    }
  }

  /** Read or mutate Stage whiteboard data only while this engine is current. */
  private withCurrentWhiteboard<T>(operation: () => T): T | undefined {
    if (!this.isCurrentPresentationLease()) return undefined;
    return operation();
  }

  /** Set callback for sending messages to widget iframe */
  setWidgetMessageCallback(callback: WidgetMessageCallback | null): void {
    this.widgetMessageCallback = callback;
  }

  /** Clean up timers when the engine is no longer needed */
  dispose(): void {
    if (this.disposed) return;
    const wasCurrent = this.isCurrentPresentationLease();
    // Invalidate the lease before cancelling callbacks. A re-entrant listener
    // or a pending promise continuation must observe this engine as stale.
    this.disposed = true;
    if (this.effectTimer) {
      clearTimeout(this.effectTimer);
      this.effectTimer = null;
    }
    this.whiteboardClearGeneration += 1;
    if (wasCurrent) this.clearOwnedWhiteboardAnimationAfterDispose();
  }

  /**
   * Cancel delayed action work owned by this engine. PlaybackEngine calls this
   * whenever its generation changes so an old scene cannot mutate a new one.
   */
  cancelPendingActions(): void {
    this.whiteboardClearGeneration += 1;
    if (this.presentationOwner) {
      // A stale/disposed presentation engine must not touch the shared Canvas
      // owned by a newer replay. Ordinary (owner-less) engines retain the
      // historical global cleanup semantics below.
      if (!this.isCurrentPresentationLease()) return;
      this.setCurrentCanvasRuntime('whiteboard', () => {
        useCanvasStore.getState().setWhiteboardClearing(false);
      });
      return;
    }
    useCanvasStore.getState().setWhiteboardClearing(false);
  }

  /**
   * Execute a single action.
   * Fire-and-forget actions return immediately.
   * Synchronous actions return a Promise that resolves when the action is complete.
   */
  async execute(action: Action, options: ActionExecutionOptions = {}): Promise<void> {
    if (!this.isCurrentPresentationLease() || options.signal?.aborted) return;

    if (options.silent) {
      if (action.type === 'speech' || action.type === 'spotlight' || action.type === 'laser') {
        return;
      }
      if (action.type === 'discussion' || action.type === 'play_video') {
        return;
      }
      if (action.type.startsWith('widget_')) {
        return;
      }
    }

    // Auto-open whiteboard if a draw/clear/delete action is attempted while it's closed
    if (action.type.startsWith('wb_') && action.type !== 'wb_open' && action.type !== 'wb_close') {
      await this.ensureWhiteboardOpen(options);
      if (!this.isCurrentPresentationLease() || options.signal?.aborted) return;
    }

    switch (action.type) {
      // Fire-and-forget
      case 'spotlight':
        this.executeSpotlight(action);
        return;
      case 'laser':
        this.executeLaser(action);
        return;
      // Synchronous — Video
      case 'play_video':
        return this.executePlayVideo(action as PlayVideoAction, options);

      // Synchronous
      case 'speech':
        return this.executeSpeech(action);
      case 'wb_open':
        return this.executeWbOpen(options);
      case 'wb_draw_text':
        return this.executeWbDrawText(action, options);
      case 'wb_draw_shape':
        return this.executeWbDrawShape(action, options);
      case 'wb_draw_chart':
        return this.executeWbDrawChart(action, options);
      case 'wb_draw_latex':
        return this.executeWbDrawLatex(action, options);
      case 'wb_draw_table':
        return this.executeWbDrawTable(action, options);
      case 'wb_draw_line':
        return this.executeWbDrawLine(action as WbDrawLineAction, options);
      case 'wb_draw_code':
        return this.executeWbDrawCode(action as WbDrawCodeAction, options);
      case 'wb_edit_code':
        return this.executeWbEditCode(action as WbEditCodeAction, options);
      case 'wb_clear':
        return this.executeWbClear(options);
      case 'wb_delete':
        return this.executeWbDelete(action as WbDeleteAction, options);
      case 'wb_close':
        return this.executeWbClose(options);
      case 'discussion':
        // Discussion lifecycle is managed externally via engine callbacks
        return;

      // Widget actions — post message to iframe
      case 'widget_highlight':
        return this.executeWidgetHighlight(action as WidgetHighlightAction, options);
      case 'widget_setState':
        return this.executeWidgetSetState(action as WidgetSetStateAction, options);
      case 'widget_annotation':
        return this.executeWidgetAnnotation(action as WidgetAnnotationAction, options);
      case 'widget_reveal':
        return this.executeWidgetReveal(action as WidgetRevealAction, options);
    }
  }

  /** Clear all active visual effects */
  clearEffects(): void {
    if (this.effectTimer) {
      clearTimeout(this.effectTimer);
      this.effectTimer = null;
    }
    this.clearCurrentCanvasChannels(CANVAS_EFFECT_CHANNELS);
  }

  resetPlaybackVisualState(): void {
    if (!this.isCurrentPresentationLease()) return;
    this.cancelPendingActions();
    this.clearEffects();
    if (this.presentationOwner) {
      this.setCurrentCanvasRuntime('video', () => {
        useCanvasStore.getState().pauseVideo();
      });
      this.setCurrentCanvasRuntime('whiteboard', () => {
        useCanvasStore.getState().setWhiteboardOpen(false);
        useCanvasStore.getState().setWhiteboardClearing(false);
      });
    } else {
      useCanvasStore.getState().pauseVideo();
      useCanvasStore.getState().setWhiteboardOpen(false);
      useCanvasStore.getState().setWhiteboardClearing(false);
    }
    const wb = this.withCurrentWhiteboard(() => this.stageAPI.whiteboard.get());
    if (!wb?.success || !wb.data || !this.isCurrentPresentationLease()) return;
    this.withCurrentWhiteboard(() => {
      this.stageAPI.whiteboard.update({ elements: [] }, wb.data!.id);
    });
  }

  /** Pause a video projection owned by this playback engine. */
  pauseVideo(): void {
    if (!this.isCurrentPresentationLease()) return;
    if (this.presentationOwner) {
      this.setCurrentCanvasRuntime('video', () => {
        useCanvasStore.getState().pauseVideo();
      });
      return;
    }
    useCanvasStore.getState().pauseVideo();
  }

  /** Set the whiteboard shell state through the presentation owner seam. */
  setWhiteboardOpen(open: boolean): void {
    if (!this.isCurrentPresentationLease()) return;
    if (this.presentationOwner) {
      this.setCurrentCanvasRuntime('whiteboard', () => {
        useCanvasStore.getState().setWhiteboardOpen(open);
      });
      return;
    }
    useCanvasStore.getState().setWhiteboardOpen(open);
  }

  /** Set the whiteboard clear-animation state through the owner seam. */
  setWhiteboardClearing(clearing: boolean): void {
    if (!this.isCurrentPresentationLease()) return;
    if (this.presentationOwner) {
      this.setCurrentCanvasRuntime('whiteboard', () => {
        useCanvasStore.getState().setWhiteboardClearing(clearing);
      });
      return;
    }
    useCanvasStore.getState().setWhiteboardClearing(clearing);
  }

  /** Schedule auto-clear for fire-and-forget effects */
  private scheduleEffectClear(): void {
    if (!this.isCurrentPresentationLease()) return;
    if (this.effectTimer) {
      clearTimeout(this.effectTimer);
    }
    this.effectTimer = setTimeout(() => {
      this.effectTimer = null;
      this.clearCurrentCanvasChannels(CANVAS_EFFECT_CHANNELS);
    }, EFFECT_AUTO_CLEAR_MS);
  }

  // ==================== Fire-and-forget ====================

  private executeSpotlight(action: SpotlightAction): void {
    this.mutateCanvas(['spotlight'], () => {
      useCanvasStore.getState().setSpotlight(action.elementId, {
        dimness: action.dimOpacity ?? 0.5,
      });
    });
    this.scheduleEffectClear();
  }

  private executeLaser(action: LaserAction): void {
    this.mutateCanvas(['laser'], () => {
      useCanvasStore.getState().setLaser(action.elementId, {
        color: action.color ?? '#ff0000',
      });
    });
    this.scheduleEffectClear();
  }

  // ==================== Synchronous — Speech ====================

  private async executeSpeech(action: SpeechAction): Promise<void> {
    if (!this.audioPlayer) return;

    return new Promise<void>((resolve) => {
      this.audioPlayer!.onEnded(() => resolve());
      this.audioPlayer!.play(action.audioId || '', action.audioUrl)
        .then((audioStarted) => {
          if (!audioStarted) resolve();
        })
        .catch(() => resolve());
    });
  }

  // ==================== Synchronous — Video ====================

  private async executePlayVideo(
    action: PlayVideoAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    if (options.signal?.aborted) return;
    // Reserve the video channel before waiting for generated media. A newer
    // replay can supersede this request while it is pending; the generation
    // check below then prevents the stale request from starting playback.
    const videoGeneration = this.claimCanvasChannel('video');
    const resolveBinding = () =>
      resolveActionVideoMedia(
        this.stageStore,
        useMediaGenerationStore.getState().tasks,
        action.elementId,
      );
    const binding = resolveBinding();

    if (binding) {
      const task = binding.task;
      if (task && task.status !== 'done') {
        // Wait for media to be ready (or fail)
        await new Promise<void>((resolve) => {
          let unsubscribe = () => {};
          const finish = () => {
            unsubscribe();
            options.signal?.removeEventListener('abort', finish);
            resolve();
          };
          unsubscribe = useMediaGenerationStore.subscribe((state) => {
            const t = resolveActionVideoMedia(this.stageStore, state.tasks, action.elementId)?.task;
            if (!t || t.status === 'done' || t.status === 'failed') {
              finish();
            }
          });
          options.signal?.addEventListener('abort', finish, { once: true });
          // Check again in case it resolved between getState and subscribe
          const current = resolveBinding()?.task;
          if (!current || current.status === 'done' || current.status === 'failed') {
            finish();
          }
        });

        if (options.signal?.aborted) return;

        // If failed, skip playback
        if (resolveBinding()?.task?.status === 'failed') {
          return;
        }
      }
    }

    if (options.signal?.aborted) return;
    if (!this.isCurrentCanvasChannel('video', videoGeneration)) return;
    this.mutateCanvas(['video'], () => {
      useCanvasStore.getState().playVideo(action.elementId);
    });

    // Wait until the video finishes playing, with a safety timeout to prevent
    // the playback engine from hanging indefinitely if the video element is
    // invalid or the state change is missed.
    return new Promise<void>((resolve) => {
      let finished = false;
      let unsubscribe = () => {};
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        unsubscribe();
        options.signal?.removeEventListener('abort', abortPlayback);
        resolve();
      };
      const abortPlayback = () => {
        if (useCanvasStore.getState().playingVideoElementId === action.elementId) {
          this.pauseVideo();
        }
        finish();
      };
      const timeout = setTimeout(() => {
        log.warn(`[playVideo] Timeout waiting for video ${action.elementId} to finish`);
        finish();
      }, MAX_VIDEO_WAIT_MS);
      unsubscribe = useCanvasStore.subscribe((state) => {
        if (state.playingVideoElementId !== action.elementId) {
          this.syncCurrentCanvasChannel('video');
          finish();
        }
      });
      options.signal?.addEventListener('abort', abortPlayback, { once: true });
      if (useCanvasStore.getState().playingVideoElementId !== action.elementId) {
        this.syncCurrentCanvasChannel('video');
        finish();
      }
    });
  }

  // ==================== Synchronous — Whiteboard ====================

  /** Auto-open the whiteboard if it's not already open */
  private async ensureWhiteboardOpen(options: ActionExecutionOptions = {}): Promise<void> {
    if (!useCanvasStore.getState().whiteboardOpen) {
      await this.executeWbOpen(options);
    }
  }

  private async executeWbOpen(options: ActionExecutionOptions = {}): Promise<void> {
    if (options.signal?.aborted) return;
    // Ensure a whiteboard exists
    this.withCurrentWhiteboard(() => this.stageAPI.whiteboard.get());
    if (!this.isCurrentPresentationLease() || options.signal?.aborted) return;
    this.mutateCanvas(['whiteboard'], () => {
      useCanvasStore.getState().setWhiteboardOpen(true);
    });
    if (options.silent) return;
    // Wait for open animation to complete (slow spring: stiffness 120, damping 18, mass 1.2)
    await delayWithSignal(WB_OPEN_MS, options.signal);
  }

  private async executeWbDrawText(
    action: WbDrawTextAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    if (options.signal?.aborted) return;
    let htmlContent = action.content ?? '';
    if (!htmlContent) return; // nothing to draw

    const latex = getLikelyLatexMath(htmlContent);
    if (latex !== null) {
      return this.executeWbDrawLatex(
        {
          ...action,
          type: 'wb_draw_latex',
          latex,
        },
        options,
      );
    }

    const wb = this.withCurrentWhiteboard(() => this.stageAPI.whiteboard.get());
    if (!wb?.success || !wb.data) return;
    if (!this.isCurrentPresentationLease() || options.signal?.aborted) return;

    const fontSize = action.fontSize ?? 18;
    if (!htmlContent.startsWith('<')) {
      htmlContent = `<p style="font-size: ${fontSize}px;">${htmlContent}</p>`;
    }

    this.withCurrentWhiteboard(() =>
      this.stageAPI.whiteboard.addElement(
        {
          id: action.elementId || '',
          type: 'text',
          content: htmlContent,
          left: action.x,
          top: action.y,
          width: action.width ?? 400,
          height: action.height ?? 100,
          rotate: 0,
          defaultFontName: 'Microsoft YaHei',
          defaultColor: action.color ?? '#333333',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        wb.data!.id,
      ),
    );

    if (!options.silent) {
      // Wait for element fade-in animation
      await delayWithSignal(WB_DRAW_MS, options.signal);
    }
  }

  private async executeWbDrawShape(
    action: WbDrawShapeAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    if (options.signal?.aborted) return;
    const wb = this.withCurrentWhiteboard(() => this.stageAPI.whiteboard.get());
    if (!wb?.success || !wb.data) return;
    if (!this.isCurrentPresentationLease() || options.signal?.aborted) return;

    this.withCurrentWhiteboard(() =>
      this.stageAPI.whiteboard.addElement(
        {
          id: action.elementId || '',
          type: 'shape',
          viewBox: [1000, 1000] as [number, number],
          path: SHAPE_PATHS[action.shape] ?? SHAPE_PATHS.rectangle,
          left: action.x,
          top: action.y,
          width: action.width,
          height: action.height,
          rotate: 0,
          fill: action.fillColor ?? '#5b9bd5',
          fixedRatio: false,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        wb.data!.id,
      ),
    );

    if (!options.silent) {
      // Wait for element fade-in animation
      await delayWithSignal(WB_DRAW_MS, options.signal);
    }
  }

  private async executeWbDrawChart(
    action: WbDrawChartAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    if (options.signal?.aborted) return;
    const wb = this.withCurrentWhiteboard(() => this.stageAPI.whiteboard.get());
    if (!wb?.success || !wb.data) return;
    if (!this.isCurrentPresentationLease() || options.signal?.aborted) return;

    this.withCurrentWhiteboard(() =>
      this.stageAPI.whiteboard.addElement(
        {
          id: action.elementId || '',
          type: 'chart',
          left: action.x,
          top: action.y,
          width: action.width,
          height: action.height,
          rotate: 0,
          chartType: action.chartType,
          data: action.data,
          themeColors: action.themeColors ?? [
            '#5b9bd5',
            '#ed7d31',
            '#a5a5a5',
            '#ffc000',
            '#4472c4',
          ],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        wb.data!.id,
      ),
    );

    if (!options.silent) await delayWithSignal(WB_DRAW_MS, options.signal);
  }

  private async executeWbDrawLatex(
    action: WbDrawLatexAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    if (options.signal?.aborted) return;
    const wb = this.withCurrentWhiteboard(() => this.stageAPI.whiteboard.get());
    if (!wb?.success || !wb.data) return;
    if (!this.isCurrentPresentationLease() || options.signal?.aborted) return;

    try {
      const html = katex.renderToString(action.latex, {
        throwOnError: false,
        displayMode: true,
        output: 'html',
      });

      this.withCurrentWhiteboard(() =>
        this.stageAPI.whiteboard.addElement(
          {
            id: action.elementId || '',
            type: 'latex',
            left: action.x,
            top: action.y,
            width: action.width ?? 400,
            height: action.height ?? 80,
            rotate: 0,
            latex: action.latex,
            html,
            color: action.color ?? '#000000',
            fixedRatio: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
          wb.data!.id,
        ),
      );
    } catch (err) {
      log.warn(`Failed to render latex "${action.latex}":`, err);
      return;
    }

    if (!options.silent) await delayWithSignal(WB_DRAW_MS, options.signal);
  }

  private async executeWbDrawTable(
    action: WbDrawTableAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    if (options.signal?.aborted) return;
    const wb = this.withCurrentWhiteboard(() => this.stageAPI.whiteboard.get());
    if (!wb?.success || !wb.data) return;
    if (!this.isCurrentPresentationLease() || options.signal?.aborted) return;

    const rows = action.data.length;
    const cols = rows > 0 ? action.data[0].length : 0;
    if (rows === 0 || cols === 0) return;

    // Build colWidths: equal distribution
    const colWidths = Array(cols).fill(1 / cols);

    // Build TableCell[][] from string[][]
    let cellId = 0;
    const tableData = action.data.map((row) =>
      row.map((text) => ({
        id: `cell_${cellId++}`,
        colspan: 1,
        rowspan: 1,
        text,
      })),
    );

    this.withCurrentWhiteboard(() =>
      this.stageAPI.whiteboard.addElement(
        {
          id: action.elementId || '',
          type: 'table',
          left: action.x,
          top: action.y,
          width: action.width,
          height: action.height,
          rotate: 0,
          colWidths,
          cellMinHeight: 36,
          data: tableData,
          outline: action.outline ?? {
            width: 2,
            style: 'solid',
            color: '#eeece1',
          },
          theme: action.theme
            ? {
                color: action.theme.color,
                rowHeader: true,
                rowFooter: false,
                colHeader: false,
                colFooter: false,
              }
            : undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        wb.data!.id,
      ),
    );

    if (!options.silent) await delayWithSignal(WB_DRAW_MS, options.signal);
  }

  private async executeWbDrawLine(
    action: WbDrawLineAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    if (options.signal?.aborted) return;
    const wb = this.withCurrentWhiteboard(() => this.stageAPI.whiteboard.get());
    if (!wb?.success || !wb.data) return;
    if (!this.isCurrentPresentationLease() || options.signal?.aborted) return;

    // Calculate bounding box — left/top is the minimum of start/end coordinates
    const left = Math.min(action.startX, action.endX);
    const top = Math.min(action.startY, action.endY);

    // Convert absolute coordinates to relative coordinates (relative to left/top)
    const start: [number, number] = [action.startX - left, action.startY - top];
    const end: [number, number] = [action.endX - left, action.endY - top];

    this.withCurrentWhiteboard(() =>
      this.stageAPI.whiteboard.addElement(
        {
          id: action.elementId || '',
          type: 'line',
          left,
          top,
          width: action.width ?? 2,
          start,
          end,
          style: action.style ?? 'solid',
          color: action.color ?? '#333333',
          points: action.points ?? ['', ''],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        wb.data!.id,
      ),
    );

    if (!options.silent) {
      // Wait for element fade-in animation
      await delayWithSignal(WB_DRAW_MS, options.signal);
    }
  }

  private async executeWbDrawCode(
    action: WbDrawCodeAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    if (options.signal?.aborted) return;
    const wb = this.withCurrentWhiteboard(() => this.stageAPI.whiteboard.get());
    if (!wb?.success || !wb.data) return;
    if (!this.isCurrentPresentationLease() || options.signal?.aborted) return;

    const lines = codeToLines(action.code);
    const suppliedLineIds = (action as WbDrawCodeAction & { lineIds?: string[] }).lineIds;
    if (suppliedLineIds?.length === lines.length) {
      lines.forEach((line, index) => {
        line.id = suppliedLineIds[index];
      });
    }

    this.withCurrentWhiteboard(() =>
      this.stageAPI.whiteboard.addElement(
        {
          id: action.elementId || '',
          type: 'code',
          language: action.language,
          lines,
          fileName: action.fileName,
          showLineNumbers: true,
          fontSize: 14,
          left: action.x,
          top: action.y,
          width: action.width ?? 500,
          height: action.height ?? 300,
          rotate: 0,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        wb.data!.id,
      ),
    );

    if (!options.silent) {
      // Wait for typing animation (base 800ms + 50ms/line, capped at 3s)
      const animMs = wbDrawCodeMs(lines.length);
      await delayWithSignal(animMs, options.signal);
    }
  }

  private async executeWbEditCode(
    action: WbEditCodeAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    if (options.signal?.aborted) return;
    const wb = this.withCurrentWhiteboard(() => this.stageAPI.whiteboard.get());
    if (!wb?.success || !wb.data) return;
    if (!this.isCurrentPresentationLease() || options.signal?.aborted) return;

    const elementResult = this.withCurrentWhiteboard(() =>
      this.stageAPI.whiteboard.getElement(action.elementId, wb.data!.id),
    );
    if (!elementResult?.success || !elementResult.data) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const element = elementResult.data as any;
    if (element.type !== 'code') return;

    let lines: CodeLine[] = [...element.lines];
    const newContentLines = action.content ? action.content.split('\n') : [];
    const suppliedLineIds = (action as WbEditCodeAction & { newLineIds?: string[] }).newLineIds;
    const newLineIds =
      suppliedLineIds?.length === newContentLines.length
        ? suppliedLineIds
        : generateLineIds(newContentLines.length);

    switch (action.operation) {
      case 'insert_after': {
        const idx = lines.findIndex((l) => l.id === action.lineId);
        if (idx === -1) return;
        const newLines = newContentLines.map((content, i) => ({ id: newLineIds[i], content }));
        lines.splice(idx + 1, 0, ...newLines);
        break;
      }
      case 'insert_before': {
        const idx = lines.findIndex((l) => l.id === action.lineId);
        if (idx === -1) return;
        const newLines = newContentLines.map((content, i) => ({ id: newLineIds[i], content }));
        lines.splice(idx, 0, ...newLines);
        break;
      }
      case 'delete_lines': {
        if (!action.lineIds?.length) return;
        const deleteSet = new Set(action.lineIds);
        lines = lines.filter((l) => !deleteSet.has(l.id));
        break;
      }
      case 'replace_lines': {
        if (!action.lineIds?.length) return;
        const replaceIds = action.lineIds;
        const firstIdx = lines.findIndex((l) => l.id === replaceIds[0]);
        if (firstIdx === -1) return;
        const deleteSet = new Set(replaceIds);
        lines = lines.filter((l) => !deleteSet.has(l.id));
        const newLines = newContentLines.map((content, i) => ({
          id: i < replaceIds.length ? replaceIds[i] : newLineIds[i],
          content,
        }));
        lines.splice(firstIdx, 0, ...newLines);
        break;
      }
    }

    if (!this.isCurrentPresentationLease()) return;
    this.withCurrentWhiteboard(() =>
      this.stageAPI.whiteboard.updateElement(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { ...element, lines } as any,
        wb.data!.id,
      ),
    );

    if (!options.silent) {
      // Wait for edit animation
      await delayWithSignal(WB_EDIT_MS, options.signal);
    }
  }

  private async executeWbDelete(
    action: WbDeleteAction,
    options: ActionExecutionOptions = {},
  ): Promise<void> {
    if (options.signal?.aborted) return;
    const wb = this.withCurrentWhiteboard(() => this.stageAPI.whiteboard.get());
    if (!wb?.success || !wb.data) return;
    if (!this.isCurrentPresentationLease() || options.signal?.aborted) return;

    this.withCurrentWhiteboard(() =>
      this.stageAPI.whiteboard.deleteElement(action.elementId, wb.data!.id),
    );
    if (!options.silent) await delayWithSignal(WB_DELETE_MS, options.signal);
  }

  private async executeWbClear(options: ActionExecutionOptions = {}): Promise<void> {
    if (options.signal?.aborted) return;
    const wb = this.withCurrentWhiteboard(() => this.stageAPI.whiteboard.get());
    if (!wb?.success || !wb.data) return;
    if (!this.isCurrentPresentationLease() || options.signal?.aborted) return;

    const elementCount = wb.data.elements?.length || 0;
    if (elementCount === 0) return;
    const whiteboardGeneration = this.claimCanvasChannel('whiteboard');
    if (this.presentationOwner && whiteboardGeneration === undefined) return;

    const clearGeneration = ++this.whiteboardClearGeneration;
    const stageId = this.stageStore.getState().stage?.id;
    const isCurrentClear = () => this.whiteboardClearGeneration === clearGeneration;
    const clearAnimationState = () => {
      if (isCurrentClear()) this.setWhiteboardClearing(false);
    };
    const ownsWhiteboard = () => {
      if (!isCurrentClear() || !this.isCurrentPresentationLease() || options.signal?.aborted) {
        return false;
      }
      if (this.presentationOwner) {
        const generation = this.canvasClaimGenerations.get('whiteboard');
        if (generation === undefined || !this.isCurrentCanvasChannel('whiteboard', generation)) {
          return false;
        }
      }
      const state = this.stageStore.getState();
      const currentWhiteboard = state.stage?.whiteboard?.find(
        (candidate) => candidate.id === wb.data!.id,
      );
      return state.stage?.id === stageId && currentWhiteboard === wb.data;
    };

    if (options.silent) {
      if (!ownsWhiteboard()) return;
      this.withCurrentWhiteboard(() =>
        this.stageAPI.whiteboard.update({ elements: [] }, wb.data!.id),
      );
      clearAnimationState();
      return;
    }

    // Save snapshot before AI clear (mirrors UI handleClear in index.tsx)
    if (!this.isCurrentPresentationLease()) return;
    useWhiteboardHistoryStore.getState().pushSnapshot(wb.data.elements!);

    // Trigger cascade exit animation
    this.mutateCanvas(['whiteboard'], () => {
      useCanvasStore.getState().setWhiteboardClearing(true);
    });

    // Wait for cascade (base 380ms + 55ms/element, capped at 1400ms)
    const animMs = wbClearMs(elementCount);
    const completed = await delayWithSignal(animMs, options.signal);
    if (!completed || !ownsWhiteboard()) {
      clearAnimationState();
      return;
    }

    // Actually remove elements
    if (!ownsWhiteboard()) {
      clearAnimationState();
      return;
    }
    this.withCurrentWhiteboard(() =>
      this.stageAPI.whiteboard.update({ elements: [] }, wb.data!.id),
    );
    clearAnimationState();
  }

  private async executeWbClose(options: ActionExecutionOptions = {}): Promise<void> {
    if (options.signal?.aborted) return;
    this.mutateCanvas(['whiteboard'], () => {
      useCanvasStore.getState().setWhiteboardOpen(false);
    });
    if (options.silent) return;
    // Wait for close animation (500ms ease-out tween)
    await delayWithSignal(WB_CLOSE_MS, options.signal);
  }

  // ==================== Widget Actions ====================

  /** Send message to widget iframe */
  private async sendWidgetMessage(
    type: string,
    payload: Record<string, unknown>,
    options: ActionExecutionOptions,
  ): Promise<void> {
    if (!this.widgetMessageCallback) {
      throw new Error(`Widget message callback not set, cannot send: ${type}`);
    }
    await this.widgetMessageCallback(type, payload, { signal: options.signal });
    await delayWithSignal(WIDGET_MS, options.signal);
  }

  /** Execute widget highlight action (quick visual change) */
  private async executeWidgetHighlight(
    action: WidgetHighlightAction,
    options: ActionExecutionOptions,
  ): Promise<void> {
    await this.sendWidgetMessage(
      'HIGHLIGHT_ELEMENT',
      {
        target: action.target,
        content: action.content,
      },
      options,
    );
  }

  /** Execute widget setState action */
  private async executeWidgetSetState(
    action: WidgetSetStateAction,
    options: ActionExecutionOptions,
  ): Promise<void> {
    await this.sendWidgetMessage(
      'SET_WIDGET_STATE',
      { state: action.state, content: action.content },
      options,
    );
  }

  /** Execute widget annotation action */
  private async executeWidgetAnnotation(
    action: WidgetAnnotationAction,
    options: ActionExecutionOptions,
  ): Promise<void> {
    await this.sendWidgetMessage(
      'ANNOTATE_ELEMENT',
      {
        target: action.target,
        content: action.content,
      },
      options,
    );
  }

  /** Execute widget reveal action */
  private async executeWidgetReveal(
    action: WidgetRevealAction,
    options: ActionExecutionOptions,
  ): Promise<void> {
    await this.sendWidgetMessage(
      'REVEAL_ELEMENT',
      { target: action.target, content: action.content },
      options,
    );
  }
}
