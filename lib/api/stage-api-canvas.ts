/**
 * Stage API - Canvas Operations
 *
 * Factory function that creates the canvas namespace of the Stage API.
 * Handles background, theme, highlight, spotlight, laser, and zoom effects.
 * Uses useCanvasStore for visual overlay effects.
 */

import type { SlideContent } from '@/lib/types/stage';
import type { SlideTheme, SlideBackground } from '@livecourse/dsl';
import {
  useCanvasStore,
  type HighlightOverlayOptions,
  type LaserOptions,
  type SpotlightOptions as CanvasSpotlightOptions,
} from '@/lib/store/canvas';
import type { StageStore, APIResult, HighlightOptions, SpotlightOptions } from './stage-api-types';
import { getScene } from './stage-api-defaults';

type CanvasState = ReturnType<typeof useCanvasStore.getState>;

/**
 * The part of Canvas state owned by teaching presentation actions.
 *
 * Timer callback identity is an in-process detail. Arbitrary structured clones
 * and serialized copies restore the serializable image with a generic clear.
 */
export type CanvasPresentationSnapshot = {
  spotlightElementId: CanvasState['spotlightElementId'];
  spotlightOptions: CanvasSpotlightOptions | null;
  spotlightMode: CanvasState['spotlightMode'];
  spotlightPercentageGeometry: CanvasState['spotlightPercentageGeometry'];
  highlightedElementIds: CanvasState['highlightedElementIds'];
  highlightOptions: HighlightOverlayOptions | null;
  laserElementId: CanvasState['laserElementId'];
  laserOptions: LaserOptions | null;
  zoomTarget: CanvasState['zoomTarget'];
  /** Video playback projection used by the presentation surface. */
  playingVideoElementId?: CanvasState['playingVideoElementId'];
  /** Whiteboard shell/animation projection used by the presentation surface. */
  whiteboardOpen?: CanvasState['whiteboardOpen'];
  whiteboardClearing?: CanvasState['whiteboardClearing'];
  /** Remaining auto-clear time, keyed by effect kind. */
  timerRemainingMs: Partial<Record<CanvasEffectKind, number>>;
  /** Absolute auto-clear deadlines used to preserve time across rollback. */
  timerDeadlines: Partial<Record<CanvasEffectKind, number>>;
  /**
   * Stable identity of each owner timer captured in this image.  Remaining
   * time naturally changes between reads, so compare-and-set paths use this
   * generation (when present) instead of an exact millisecond value.
   * Snapshots captured outside an owner may omit the map.
   */
  timerGenerations?: Partial<Record<CanvasEffectKind, number>>;
  /**
   * Monotonic channel versions. Unlike an active claim, a version survives
   * cancellation so compare-and-set can detect a newer writer that produced
   * the same visual image (including zoom/video/whiteboard channels).
   */
  channelGenerations?: Partial<Record<CanvasPresentationChannelKind, number>>;
};

export type CanvasEffectKind = 'highlight' | 'spotlight' | 'laser';
export type CanvasPresentationChannelKind = CanvasEffectKind | 'zoom' | 'video' | 'whiteboard';
type CanvasChannelKind = CanvasPresentationChannelKind;

type CanvasTimerEffect = { clear: (() => void) | null; settled: boolean };
type CanvasSnapshotTimerMetadata = Partial<
  Record<CanvasEffectKind, { generation: number; effect: CanvasTimerEffect }>
>;

/**
 * Timer callbacks are runtime resources, not part of a serializable snapshot.
 * Keep them weakly attached to the snapshot that may need to restore them so
 * replacing a timer does not retain every historical callback for the whole
 * owner lifetime.
 */
const canvasSnapshotTimerMetadata = new WeakMap<
  CanvasPresentationSnapshot,
  CanvasSnapshotTimerMetadata
>();

export interface CanvasPresentationOwner {
  capture: () => CanvasPresentationSnapshot;
  restore: (snapshot: CanvasPresentationSnapshot) => void;
  /** Check whether this owner's changed channels still match `expected`. */
  canRestoreIfCurrent: (
    before: CanvasPresentationSnapshot,
    expected: CanvasPresentationSnapshot,
  ) => boolean;
  /** Restore only when the current overlay still equals `expected`. */
  restoreIfCurrent: (
    before: CanvasPresentationSnapshot,
    expected: CanvasPresentationSnapshot,
  ) => boolean;
  /** Mark the beginning/end of a teaching overlay mutation. */
  beginMutation: () => void;
  endMutation: () => void;
  /** Claim an effect channel before writing a new overlay. */
  claim: (kind: CanvasChannelKind) => number;
  /** Return whether this owner still holds the supplied claim generation. */
  isCurrent: (kind: CanvasChannelKind, generation: number) => boolean;
  cancel: (kind: CanvasChannelKind) => void;
  schedule: (kind: CanvasEffectKind, duration: number, clear: () => void) => void;
  /** Restore the owner baseline captured by the first effective mutation. */
  restoreBaseline: () => void;
  dispose: () => void;
}

function cloneCanvasSnapshot(snapshot: CanvasPresentationSnapshot): CanvasPresentationSnapshot {
  const clone = structuredClone(snapshot);
  const metadata = canvasSnapshotTimerMetadata.get(snapshot);
  if (metadata) {
    canvasSnapshotTimerMetadata.set(clone, { ...metadata });
  }
  return clone;
}

function setSnapshotTimerMetadata(
  snapshot: CanvasPresentationSnapshot,
  kind: CanvasEffectKind,
  generation: number,
  effect: CanvasTimerEffect,
): void {
  const metadata = canvasSnapshotTimerMetadata.get(snapshot) ?? {};
  metadata[kind] = { generation, effect };
  canvasSnapshotTimerMetadata.set(snapshot, metadata);
}

function copySnapshotTimerMetadata(
  target: CanvasPresentationSnapshot,
  source: CanvasPresentationSnapshot,
  kind: CanvasEffectKind,
): void {
  const sourceMetadata = canvasSnapshotTimerMetadata.get(source)?.[kind];
  const targetMetadata = canvasSnapshotTimerMetadata.get(target) ?? {};
  if (sourceMetadata) targetMetadata[kind] = sourceMetadata;
  else delete targetMetadata[kind];

  if (Object.keys(targetMetadata).length === 0) canvasSnapshotTimerMetadata.delete(target);
  else canvasSnapshotTimerMetadata.set(target, targetMetadata);
}

const CANVAS_EFFECT_KINDS: readonly CanvasEffectKind[] = ['highlight', 'spotlight', 'laser'];

const CANVAS_CHANNEL_KINDS: readonly CanvasChannelKind[] = [
  ...CANVAS_EFFECT_KINDS,
  'zoom',
  'video',
  'whiteboard',
];

function isCanvasEffectKind(kind: CanvasChannelKind): kind is CanvasEffectKind {
  return (CANVAS_EFFECT_KINDS as readonly CanvasChannelKind[]).includes(kind);
}

function clearCanvasEffect(kind: CanvasEffectKind): void {
  const canvas = useCanvasStore.getState();
  if (kind === 'highlight') canvas.clearHighlight();
  else if (kind === 'spotlight') canvas.clearSpotlight();
  else canvas.clearLaser();
}

function hasTimer(snapshot: CanvasPresentationSnapshot, kind: CanvasEffectKind): boolean {
  return (
    snapshot.timerGenerations?.[kind] !== undefined ||
    snapshot.timerDeadlines?.[kind] !== undefined ||
    snapshot.timerRemainingMs[kind] !== undefined
  );
}

function timerDeadline(
  snapshot: CanvasPresentationSnapshot,
  kind: CanvasEffectKind,
): number | undefined {
  if (!hasTimer(snapshot, kind)) return undefined;
  const deadline = snapshot.timerDeadlines?.[kind];
  if (deadline === undefined) {
    throw new Error(`Canvas ${kind} timer snapshot is missing an absolute deadline`);
  }
  return deadline;
}

/**
 * Compare the timer slot as an owned resource, not by its wall-clock
 * remaining milliseconds.  A countdown naturally changes between snapshots;
 * replacing a timer with another timer must nevertheless invalidate a CAS.
 */
function timerSlotEqual(
  left: CanvasPresentationSnapshot,
  right: CanvasPresentationSnapshot,
  kind: CanvasEffectKind,
): boolean {
  const leftHas = hasTimer(left, kind);
  const rightHas = hasTimer(right, kind);
  if (leftHas !== rightHas) return false;
  if (!leftHas) return true;

  const leftGeneration = left.timerGenerations?.[kind];
  const rightGeneration = right.timerGenerations?.[kind];
  // Snapshots made by an owner carry a generation.  For hand-authored or
  // legacy snapshots without one, presence is the strongest safe signal.
  return leftGeneration === undefined || rightGeneration === undefined
    ? true
    : leftGeneration === rightGeneration;
}

/**
 * Compare the monotonic ownership version for one channel. Snapshots created
 * by older callers may omit the map; in that case the metadata is treated as
 * unknown and visual/timer fields remain the strongest available signal.
 */
function channelSlotEqual(
  left: CanvasPresentationSnapshot,
  right: CanvasPresentationSnapshot,
  kind: CanvasChannelKind,
): boolean {
  if (!left.channelGenerations || !right.channelGenerations) return true;
  return left.channelGenerations[kind] === right.channelGenerations[kind];
}

function channelStateEqual(
  left: CanvasPresentationSnapshot,
  right: CanvasPresentationSnapshot,
  kind: CanvasChannelKind,
): boolean {
  if (!snapshotDefinesChannel(left, kind) || !snapshotDefinesChannel(right, kind)) return true;
  if (!channelOverlayEqual(left, right, kind)) return false;
  if (isCanvasEffectKind(kind) && !timerSlotEqual(left, right, kind)) return false;
  return channelSlotEqual(left, right, kind);
}

function snapshotDefinesChannel(
  snapshot: CanvasPresentationSnapshot,
  kind: CanvasChannelKind,
): boolean {
  if (kind === 'video') return snapshot.playingVideoElementId !== undefined;
  if (kind === 'whiteboard') {
    return snapshot.whiteboardOpen !== undefined && snapshot.whiteboardClearing !== undefined;
  }
  return true;
}

function changedCanvasChannels(
  before: CanvasPresentationSnapshot,
  after: CanvasPresentationSnapshot,
): CanvasChannelKind[] {
  return CANVAS_CHANNEL_KINDS.filter((kind) => !channelStateEqual(before, after, kind));
}

function canvasChannelsEqual(
  left: CanvasPresentationSnapshot,
  right: CanvasPresentationSnapshot,
  kinds: Iterable<CanvasChannelKind>,
): boolean {
  for (const kind of kinds) {
    if (!channelStateEqual(left, right, kind)) return false;
  }
  return true;
}

function copyCanvasChannel(
  target: CanvasPresentationSnapshot,
  source: CanvasPresentationSnapshot,
  kind: CanvasChannelKind,
): void {
  switch (kind) {
    case 'highlight':
      target.highlightedElementIds = [...source.highlightedElementIds];
      target.highlightOptions = source.highlightOptions
        ? structuredClone(source.highlightOptions)
        : null;
      break;
    case 'spotlight':
      target.spotlightElementId = source.spotlightElementId;
      target.spotlightOptions = source.spotlightOptions
        ? structuredClone(source.spotlightOptions)
        : null;
      target.spotlightMode = source.spotlightMode;
      target.spotlightPercentageGeometry = source.spotlightPercentageGeometry
        ? structuredClone(source.spotlightPercentageGeometry)
        : null;
      break;
    case 'laser':
      target.laserElementId = source.laserElementId;
      target.laserOptions = source.laserOptions ? structuredClone(source.laserOptions) : null;
      break;
    case 'zoom':
      target.zoomTarget = source.zoomTarget ? { ...source.zoomTarget } : null;
      break;
    case 'video':
      if (source.playingVideoElementId !== undefined) {
        target.playingVideoElementId = source.playingVideoElementId;
      }
      break;
    case 'whiteboard':
      if (source.whiteboardOpen !== undefined && source.whiteboardClearing !== undefined) {
        target.whiteboardOpen = source.whiteboardOpen;
        target.whiteboardClearing = source.whiteboardClearing;
      }
      break;
  }

  if (isCanvasEffectKind(kind)) {
    const remaining = source.timerRemainingMs[kind];
    const generation = source.timerGenerations?.[kind];
    if (remaining === undefined) delete target.timerRemainingMs[kind];
    else target.timerRemainingMs[kind] = remaining;
    if (target.timerDeadlines === undefined) target.timerDeadlines = {};
    const deadline = source.timerDeadlines?.[kind];
    if (deadline === undefined) delete target.timerDeadlines[kind];
    else target.timerDeadlines[kind] = deadline;
    if (target.timerGenerations === undefined) target.timerGenerations = {};
    if (generation === undefined) delete target.timerGenerations[kind];
    else target.timerGenerations[kind] = generation;
    copySnapshotTimerMetadata(target, source, kind);
  }

  if (target.channelGenerations === undefined) target.channelGenerations = {};
  const channelGeneration = source.channelGenerations?.[kind];
  if (channelGeneration === undefined) delete target.channelGenerations[kind];
  else target.channelGenerations[kind] = channelGeneration;
}

function throwCanvasErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}

function readCanvasSnapshot(
  timers: Map<CanvasEffectKind, { deadline: number; generation?: number }>,
): CanvasPresentationSnapshot {
  const state = useCanvasStore.getState();
  const timerRemainingMs: Partial<Record<CanvasEffectKind, number>> = {};
  const timerDeadlines: Partial<Record<CanvasEffectKind, number>> = {};
  const timerGenerations: Partial<Record<CanvasEffectKind, number>> = {};
  const now = Date.now();
  for (const [kind, timer] of timers) {
    timerRemainingMs[kind] = Math.max(0, timer.deadline - now);
    timerDeadlines[kind] = timer.deadline;
    if (timer.generation !== undefined) timerGenerations[kind] = timer.generation;
  }
  return {
    spotlightElementId: state.spotlightElementId,
    spotlightOptions: state.spotlightOptions ? structuredClone(state.spotlightOptions) : null,
    spotlightMode: state.spotlightMode,
    spotlightPercentageGeometry: state.spotlightPercentageGeometry
      ? structuredClone(state.spotlightPercentageGeometry)
      : null,
    highlightedElementIds: [...state.highlightedElementIds],
    highlightOptions: state.highlightOptions ? structuredClone(state.highlightOptions) : null,
    laserElementId: state.laserElementId,
    laserOptions: state.laserOptions ? structuredClone(state.laserOptions) : null,
    zoomTarget: state.zoomTarget ? { ...state.zoomTarget } : null,
    playingVideoElementId: state.playingVideoElementId,
    whiteboardOpen: state.whiteboardOpen,
    whiteboardClearing: state.whiteboardClearing,
    timerRemainingMs,
    timerDeadlines,
    timerGenerations,
    channelGenerations: Object.fromEntries(latestCanvasChannelGenerations),
  };
}

/** Capture the current teaching overlay without creating an owner or timers. */
export function captureCanvasPresentationSnapshot(): CanvasPresentationSnapshot {
  return readCanvasSnapshot(new Map());
}

/** Apply one effect channel without clobbering unrelated external channels. */
function applyCanvasChannel(kind: CanvasChannelKind, snapshot: CanvasPresentationSnapshot): void {
  switch (kind) {
    case 'highlight':
      useCanvasStore.setState({
        highlightedElementIds: [...snapshot.highlightedElementIds],
        highlightOptions: snapshot.highlightOptions
          ? structuredClone(snapshot.highlightOptions)
          : null,
      });
      return;
    case 'spotlight':
      useCanvasStore.setState({
        spotlightElementId: snapshot.spotlightElementId,
        spotlightOptions: snapshot.spotlightOptions
          ? structuredClone(snapshot.spotlightOptions)
          : null,
        spotlightMode: snapshot.spotlightMode,
        spotlightPercentageGeometry: snapshot.spotlightPercentageGeometry
          ? structuredClone(snapshot.spotlightPercentageGeometry)
          : null,
      });
      return;
    case 'laser':
      useCanvasStore.setState({
        laserElementId: snapshot.laserElementId,
        laserOptions: snapshot.laserOptions ? structuredClone(snapshot.laserOptions) : null,
      });
      return;
    case 'zoom':
      useCanvasStore.setState({
        zoomTarget: snapshot.zoomTarget ? { ...snapshot.zoomTarget } : null,
      });
      return;
    case 'video':
      if (snapshot.playingVideoElementId === undefined) return;
      useCanvasStore.setState({ playingVideoElementId: snapshot.playingVideoElementId });
      return;
    case 'whiteboard':
      if (snapshot.whiteboardOpen === undefined || snapshot.whiteboardClearing === undefined) {
        return;
      }
      useCanvasStore.setState({
        whiteboardOpen: snapshot.whiteboardOpen,
        whiteboardClearing: snapshot.whiteboardClearing,
      });
      return;
  }
}

/**
 * Canvas overlays live in one process-wide Zustand store, while replay and
 * teaching sessions each own their timers. A local timer map is therefore
 * not enough: a callback from an old owner can otherwise clear an overlay
 * written by a newer owner. Keep one generation/claim per effect channel and
 * validate it in every callback and cleanup path.
 */
type CanvasChannelClaim = { ownerId: number; generation: number };
type CanvasTimerLease = CanvasChannelClaim & {
  handle: ReturnType<typeof setTimeout>;
  deadline: number;
  effect: CanvasTimerEffect;
  /** Reinstall this timer after a temporary owner hands the channel back. */
  resume: (generation: number) => boolean;
};
type CanvasBaselineChannel = {
  snapshot: CanvasPresentationSnapshot;
  ownerId?: number;
  timerLease?: CanvasTimerLease;
};
type CanvasOwnerRegistration = {
  baselineChannel: (kind: CanvasChannelKind) => CanvasBaselineChannel | null;
  acceptRestoredChannel: (kind: CanvasChannelKind, generation: number) => boolean;
  rebaseBaselineChannel: (
    kind: CanvasChannelKind,
    removedOwnerId: number,
    replacement: CanvasBaselineChannel,
  ) => void;
};

let nextCanvasOwnerId = 1;
let nextCanvasGeneration = 1;
const activeCanvasClaims = new Map<CanvasChannelKind, CanvasChannelClaim>();
const activeCanvasTimerLeases = new Map<CanvasEffectKind, CanvasTimerLease>();
/** Timers hidden by a newer owner, ordered from oldest to newest. */
const suspendedCanvasTimerLeases = new Map<CanvasEffectKind, CanvasTimerLease[]>();
/** Last ownership version for every channel, retained after a claim ends. */
const latestCanvasChannelGenerations = new Map<CanvasChannelKind, number>();
/** Live owner journals used to splice non-LIFO presentation cleanup. */
const canvasOwnerRegistrations = new Map<number, CanvasOwnerRegistration>();

function channelOverlayEqual(
  left: CanvasPresentationSnapshot,
  right: CanvasPresentationSnapshot,
  kind: CanvasChannelKind,
): boolean {
  switch (kind) {
    case 'highlight':
      return (
        left.highlightedElementIds.join('\u0000') === right.highlightedElementIds.join('\u0000') &&
        JSON.stringify(left.highlightOptions) === JSON.stringify(right.highlightOptions)
      );
    case 'spotlight':
      return (
        left.spotlightElementId === right.spotlightElementId &&
        left.spotlightMode === right.spotlightMode &&
        JSON.stringify(left.spotlightOptions) === JSON.stringify(right.spotlightOptions) &&
        JSON.stringify(left.spotlightPercentageGeometry) ===
          JSON.stringify(right.spotlightPercentageGeometry)
      );
    case 'laser':
      return (
        left.laserElementId === right.laserElementId &&
        JSON.stringify(left.laserOptions) === JSON.stringify(right.laserOptions)
      );
    case 'zoom':
      return JSON.stringify(left.zoomTarget) === JSON.stringify(right.zoomTarget);
    case 'video':
      if (left.playingVideoElementId === undefined || right.playingVideoElementId === undefined) {
        return true;
      }
      return left.playingVideoElementId === right.playingVideoElementId;
    case 'whiteboard':
      if (
        left.whiteboardOpen === undefined ||
        left.whiteboardClearing === undefined ||
        right.whiteboardOpen === undefined ||
        right.whiteboardClearing === undefined
      ) {
        return true;
      }
      return (
        left.whiteboardOpen === right.whiteboardOpen &&
        left.whiteboardClearing === right.whiteboardClearing
      );
  }
}

/**
 * Owns effect timers and a small teaching-only Canvas snapshot. The owner is
 * deliberately independent from editor selection/viewport state.
 */
export function createCanvasPresentationOwner(
  options: { trackBaseline?: boolean } = {},
): CanvasPresentationOwner {
  const ownerId = nextCanvasOwnerId++;
  const trackBaseline = options.trackBaseline ?? true;
  const timers = new Map<
    CanvasEffectKind,
    {
      handle: ReturnType<typeof setTimeout>;
      deadline: number;
      generation: number;
      effect: CanvasTimerEffect;
    }
  >();
  const ownedKinds = new Set<CanvasChannelKind>();
  /** Channels this owner has claimed since its baseline was captured. */
  const mutatedKinds = new Set<CanvasChannelKind>();
  /** Latest monotonic version authored by this owner for each channel. */
  const latestOwnedGenerations = new Map<CanvasChannelKind, number>();
  /** Timers restored from the canonical baseline and handed off on dispose. */
  const retainedTimerKinds = new Set<CanvasEffectKind>();
  /** Timers belonging to an older owner that this owner temporarily hides. */
  const baselineTimerLeases = new Map<CanvasEffectKind, CanvasTimerLease>();
  /** Owner whose visible channel image was captured in this baseline. */
  const baselineChannelOwnerIds = new Map<CanvasChannelKind, number>();
  let disposed = false;
  let baseline: CanvasPresentationSnapshot | null = null;
  let expected: CanvasPresentationSnapshot | null = null;

  const updateExpectedChannels = (kinds: Iterable<CanvasChannelKind>): void => {
    if (!trackBaseline || !baseline || !expected) return;
    const current = capture();
    for (const kind of kinds) {
      const ownedGeneration = latestOwnedGenerations.get(kind);
      const currentGeneration = current.channelGenerations?.[kind];
      // Never absorb a newer owner's image into this owner's expected CAS.
      // A missing generation is tolerated for legacy hand-authored snapshots,
      // where visual state is the only available ownership signal.
      if (
        ownedGeneration !== undefined &&
        currentGeneration !== undefined &&
        ownedGeneration !== currentGeneration
      ) {
        continue;
      }
      copyCanvasChannel(expected, current, kind);
    }
  };

  const assertLive = () => {
    if (disposed) throw new Error('Canvas presentation owner has been disposed');
  };

  /**
   * A timer can be covered by a short-lived owner without losing the original
   * deadline.  Keep the suspended lease separate from the active claim; this
   * lets a later owner hand the exact timer back when its baseline is restored.
   */
  const removeSuspendedLease = (lease: CanvasTimerLease): void => {
    // The channel is not stored on the lease, so inspect each stack. There
    // are only three effect channels and this path is lifecycle-only.
    for (const [kind, leases] of suspendedCanvasTimerLeases) {
      const next = leases.filter((candidate) => candidate !== lease);
      if (next.length === 0) suspendedCanvasTimerLeases.delete(kind);
      else if (next.length !== leases.length) suspendedCanvasTimerLeases.set(kind, next);
    }
  };

  const removeSuspendedLeasesForOwner = (kind: CanvasEffectKind): void => {
    const leases = suspendedCanvasTimerLeases.get(kind);
    if (!leases) return;
    const remaining = leases.filter((lease) => {
      if (lease.ownerId !== ownerId) return true;
      clearTimeout(lease.handle);
      return false;
    });
    if (remaining.length === 0) suspendedCanvasTimerLeases.delete(kind);
    else if (remaining.length !== leases.length) suspendedCanvasTimerLeases.set(kind, remaining);
  };

  const suspendForeignTimer = (kind: CanvasEffectKind): void => {
    const lease = activeCanvasTimerLeases.get(kind);
    const active = activeCanvasClaims.get(kind);
    if (!lease || !active || lease.ownerId === ownerId) return;
    if (lease.ownerId !== active.ownerId || lease.generation !== active.generation) return;
    clearTimeout(lease.handle);
    activeCanvasTimerLeases.delete(kind);
    // Only the timer captured in this owner's baseline is part of the image
    // it must hand back. A foreign timer written after the baseline was taken
    // has been superseded by this mutation and must stay cancelled.
    if (baselineTimerLeases.get(kind) !== lease) return;
    const stack = suspendedCanvasTimerLeases.get(kind) ?? [];
    if (!stack.includes(lease)) stack.push(lease);
    suspendedCanvasTimerLeases.set(kind, stack);
  };

  const clearOwnTimer = (kind: CanvasEffectKind): void => {
    const timer = timers.get(kind);
    if (timer) {
      clearTimeout(timer.handle);
      timers.delete(kind);
    }
    const lease = activeCanvasTimerLeases.get(kind);
    const active = activeCanvasClaims.get(kind);
    if (
      lease &&
      active?.ownerId === ownerId &&
      lease.ownerId === ownerId &&
      lease.generation === active.generation
    ) {
      clearTimeout(lease.handle);
      activeCanvasTimerLeases.delete(kind);
    }
    // An explicit cancellation means this owner no longer wants an older
    // suspended timer resurrected if it later reclaims the channel.
    const suspended = suspendedCanvasTimerLeases.get(kind);
    if (suspended) {
      const remaining = suspended.filter((candidate) => {
        if (candidate.ownerId !== ownerId) return true;
        clearTimeout(candidate.handle);
        return false;
      });
      if (remaining.length === 0) suspendedCanvasTimerLeases.delete(kind);
      else if (remaining.length !== suspended.length) {
        suspendedCanvasTimerLeases.set(kind, remaining);
      }
    }
  };

  const cancel = (kind: CanvasChannelKind) => {
    if (isCanvasEffectKind(kind)) retainedTimerKinds.delete(kind);
    if (isCanvasEffectKind(kind)) {
      clearOwnTimer(kind);
    }
    const claim = activeCanvasClaims.get(kind);
    if (claim?.ownerId === ownerId) {
      activeCanvasClaims.delete(kind);
      ownedKinds.delete(kind);
      // A cancellation is itself a channel transition for non-timer state.
      // Advance the version so a stale compare-and-set cannot succeed merely
      // because the replacement image happens to be byte-identical.
      if (kind === 'video' || kind === 'whiteboard' || kind === 'zoom') {
        const generation = nextCanvasGeneration++;
        latestCanvasChannelGenerations.set(kind, generation);
        latestOwnedGenerations.set(kind, generation);
        mutatedKinds.add(kind);
      }
    } else {
      // A newer owner may have replaced this channel before the old owner's
      // cleanup runs. Drop the stale local ownership marker without touching
      // the replacement claim or lease.
      ownedKinds.delete(kind);
    }
  };

  const claim = (kind: CanvasChannelKind): number => {
    assertLive();
    if (isCanvasEffectKind(kind)) retainedTimerKinds.delete(kind);
    const active = activeCanvasClaims.get(kind);
    if (active?.ownerId === ownerId) {
      // Replacing this owner's own effect is a real transition, but it must
      // not put the old timer on the cross-owner suspension stack.
      if (isCanvasEffectKind(kind)) clearOwnTimer(kind);
      activeCanvasClaims.delete(kind);
      ownedKinds.delete(kind);
    } else if (isCanvasEffectKind(kind)) {
      // Preserve a foreign timer so a temporary owner can hand it back after
      // restoring its baseline. The foreign claim itself is still replaced.
      suspendForeignTimer(kind);
      clearOwnTimer(kind);
      activeCanvasClaims.delete(kind);
    } else {
      activeCanvasClaims.delete(kind);
    }
    const generation = nextCanvasGeneration++;
    activeCanvasClaims.set(kind, { ownerId, generation });
    latestCanvasChannelGenerations.set(kind, generation);
    latestOwnedGenerations.set(kind, generation);
    ownedKinds.add(kind);
    mutatedKinds.add(kind);
    return generation;
  };

  const isCurrent = (kind: CanvasChannelKind, generation: number): boolean => {
    if (disposed) return false;
    const active = activeCanvasClaims.get(kind);
    return active?.ownerId === ownerId && active.generation === generation;
  };

  const capture = (): CanvasPresentationSnapshot => {
    assertLive();
    const snapshot = readCanvasSnapshot(timers);
    for (const [kind, timer] of timers) {
      setSnapshotTimerMetadata(snapshot, kind, timer.generation, timer.effect);
    }
    return snapshot;
  };

  const timerEffectFromSnapshot = (
    snapshot: CanvasPresentationSnapshot,
    kind: CanvasEffectKind,
  ): CanvasTimerEffect => {
    const generation = snapshot.timerGenerations?.[kind];
    const metadata = canvasSnapshotTimerMetadata.get(snapshot)?.[kind];
    const preserved = metadata && metadata.generation === generation ? metadata.effect : undefined;
    return preserved && !preserved.settled && preserved.clear
      ? preserved
      : { clear: () => clearCanvasEffect(kind), settled: false };
  };

  const restoreChannels = (
    snapshot: CanvasPresentationSnapshot,
    kinds: Iterable<CanvasChannelKind>,
  ) => {
    assertLive();
    const requestedKinds = [...kinds];
    const snapshotTimerDeadlines = new Map<CanvasEffectKind, number>();
    for (const kind of requestedKinds) {
      if (!isCanvasEffectKind(kind)) continue;
      const deadline = timerDeadline(snapshot, kind);
      if (deadline !== undefined) snapshotTimerDeadlines.set(kind, deadline);
    }

    const current = capture();
    const changedKinds = requestedKinds.filter(
      (kind) => !channelStateEqual(current, snapshot, kind),
    );
    if (changedKinds.length === 0) return;

    const timerRestores = new Map<
      CanvasEffectKind,
      { deadline: number; effect: CanvasTimerEffect }
    >();
    for (const kind of CANVAS_EFFECT_KINDS) {
      if (!changedKinds.includes(kind)) continue;
      const deadline = snapshotTimerDeadlines.get(kind);
      if (deadline !== undefined) {
        timerRestores.set(kind, {
          deadline,
          effect: timerEffectFromSnapshot(snapshot, kind),
        });
      }
    }

    // Only claim channels this owner is actually restoring. This prevents a
    // stage-only action's cleanup from cancelling an unrelated owner's timer
    // on another channel, and lets a timer-only change (same visual overlay,
    // different duration) restore the exact timer resource.
    for (const kind of changedKinds) claim(kind);
    let restoreError: unknown;
    try {
      for (const kind of changedKinds) {
        if (isCanvasEffectKind(kind)) {
          const timerRestore = timerRestores.get(kind);
          if (timerRestore && timerRestore.deadline <= Date.now()) {
            expireCurrentTimer(kind, timerRestore.effect);
            continue;
          }

          applyCanvasChannel(kind, snapshot);
          if (timerRestore) {
            const active = activeCanvasClaims.get(kind);
            if (!active || active.ownerId !== ownerId) {
              throw new Error('Canvas effect channel was lost during restore');
            }
            installTimer(kind, active.generation, timerRestore.deadline, timerRestore.effect);
          }
          continue;
        }

        applyCanvasChannel(kind, snapshot);
      }
    } catch (cause) {
      restoreError = cause;
    } finally {
      updateExpectedChannels(changedKinds);
    }
    if (restoreError) throw restoreError;
  };

  const restore = (snapshot: CanvasPresentationSnapshot) => {
    restoreChannels(snapshot, CANVAS_CHANNEL_KINDS);
  };

  const planRestoreIfCurrent = (
    before: CanvasPresentationSnapshot,
    expectedSnapshot: CanvasPresentationSnapshot,
  ) => {
    assertLive();
    const actionKinds = changedCanvasChannels(before, expectedSnapshot).filter((kind) => {
      const expectedGeneration = expectedSnapshot.channelGenerations?.[kind];
      return expectedGeneration === undefined
        ? mutatedKinds.has(kind)
        : latestOwnedGenerations.get(kind) === expectedGeneration;
    });
    return {
      actionKinds,
      matches:
        actionKinds.length === 0 || canvasChannelsEqual(capture(), expectedSnapshot, actionKinds),
    };
  };

  const canRestoreIfCurrent = (
    before: CanvasPresentationSnapshot,
    expectedSnapshot: CanvasPresentationSnapshot,
  ): boolean => planRestoreIfCurrent(before, expectedSnapshot).matches;

  const restoreIfCurrent = (
    before: CanvasPresentationSnapshot,
    expectedSnapshot: CanvasPresentationSnapshot,
  ): boolean => {
    const plan = planRestoreIfCurrent(before, expectedSnapshot);
    if (!plan.matches) return false;
    // A Stage-only action may open a transaction without touching Canvas. It
    // must never restore an unrelated channel that changed concurrently.
    if (plan.actionKinds.length > 0) restoreChannels(before, plan.actionKinds);
    return true;
  };

  const beginMutation = () => {
    assertLive();
    if (trackBaseline && !baseline) {
      baseline = capture();
      expected = cloneCanvasSnapshot(baseline);
      // `capture()` only includes timers created by this owner. Record any
      // currently active foreign timer separately so a temporary nested owner
      // can restore the exact deadline and callback when it hands the channel
      // back. The visual snapshot remains deliberately owner-local for CAS.
      for (const kind of CANVAS_EFFECT_KINDS) {
        if (timers.has(kind)) continue;
        const lease = activeCanvasTimerLeases.get(kind);
        const active = activeCanvasClaims.get(kind);
        if (lease && active?.ownerId === lease.ownerId && lease.ownerId !== ownerId) {
          baselineTimerLeases.set(kind, lease);
        }
      }
      for (const kind of CANVAS_CHANNEL_KINDS) {
        const active = activeCanvasClaims.get(kind);
        if (active && active.ownerId !== ownerId) {
          baselineChannelOwnerIds.set(kind, active.ownerId);
        }
      }
    }
  };

  const endMutation = () => {
    assertLive();
    updateExpectedChannels(mutatedKinds);
  };

  type TimerInstall = (
    kind: CanvasEffectKind,
    generation: number,
    deadline: number,
    effect: CanvasTimerEffect,
  ) => CanvasTimerLease;

  const settleOwnedTimer = (
    kind: CanvasEffectKind,
    generation: number,
    effect: CanvasTimerEffect,
  ): void => {
    retainedTimerKinds.delete(kind);
    try {
      if (effect.settled) {
        clearCanvasEffect(kind);
      } else {
        effect.settled = true;
        effect.clear?.();
      }
    } finally {
      // A settled callback can retain a large action payload. Keep the small
      // effect record available for stale snapshots, but release that closure
      // as soon as the timer has settled.
      effect.clear = null;
      // A subscriber may synchronously install another timer while `clear`
      // runs. Remove only the generation that actually expired.
      const latestGeneration = latestCanvasChannelGenerations.get(kind);
      const activeAfter = activeCanvasClaims.get(kind);
      if (
        latestGeneration === generation &&
        activeAfter?.ownerId === ownerId &&
        activeAfter.generation === generation
      ) {
        activeCanvasClaims.delete(kind);
        ownedKinds.delete(kind);
        updateExpectedChannels([kind]);
      } else if (activeAfter?.ownerId !== ownerId) {
        ownedKinds.delete(kind);
      }
    }
  };

  const expireCurrentTimer = (kind: CanvasEffectKind, effect: CanvasTimerEffect): void => {
    const active = activeCanvasClaims.get(kind);
    if (!active || active.ownerId !== ownerId) return;
    const current = timers.get(kind);
    if (current) {
      clearTimeout(current.handle);
      timers.delete(kind);
    }
    const lease = activeCanvasTimerLeases.get(kind);
    if (lease?.ownerId === ownerId && lease.generation === active.generation) {
      clearTimeout(lease.handle);
      activeCanvasTimerLeases.delete(kind);
    }
    settleOwnedTimer(kind, active.generation, effect);
  };

  const installTimer: TimerInstall = (kind, generation, deadline, effect) => {
    const claim = { ownerId, generation };
    const handle = setTimeout(
      () => {
        const current = timers.get(kind);
        const active = activeCanvasClaims.get(kind);
        const activeLease = activeCanvasTimerLeases.get(kind);
        if (
          !current ||
          current.generation !== generation ||
          current.handle !== handle ||
          !active ||
          active.ownerId !== ownerId ||
          active.generation !== generation ||
          !activeLease ||
          activeLease.ownerId !== ownerId ||
          activeLease.generation !== generation ||
          activeLease.handle !== handle
        ) {
          if (current?.generation === generation && current.handle === handle) timers.delete(kind);
          return;
        }

        timers.delete(kind);
        activeCanvasTimerLeases.delete(kind);
        settleOwnedTimer(kind, generation, effect);
      },
      Math.max(0, deadline - Date.now()),
    );

    const lease: CanvasTimerLease = {
      ...claim,
      handle,
      deadline,
      effect,
      resume: (nextGeneration: number): boolean => {
        if (disposed && !retainedTimerKinds.has(kind)) return false;
        const current = timers.get(kind);
        if (!current || current.generation !== generation) return false;
        clearTimeout(current.handle);
        latestCanvasChannelGenerations.set(kind, nextGeneration);
        latestOwnedGenerations.set(kind, nextGeneration);
        ownedKinds.add(kind);
        mutatedKinds.add(kind);
        if (deadline <= Date.now()) {
          timers.delete(kind);
          activeCanvasClaims.set(kind, { ownerId, generation: nextGeneration });
          settleOwnedTimer(kind, nextGeneration, effect);
        } else {
          installTimer(kind, nextGeneration, deadline, effect);
          updateExpectedChannels([kind]);
        }
        return true;
      },
    };
    timers.set(kind, { handle, deadline, generation, effect });
    activeCanvasClaims.set(kind, claim);
    activeCanvasTimerLeases.set(kind, lease);
    return lease;
  };

  const scheduleAt = (kind: CanvasEffectKind, deadline: number, clear: () => void) => {
    assertLive();
    const effect = { clear, settled: false };
    claim(kind);
    const activeClaim = activeCanvasClaims.get(kind);
    if (!activeClaim || activeClaim.ownerId !== ownerId) {
      throw new Error('Canvas effect channel was lost');
    }
    if (deadline <= Date.now()) {
      expireCurrentTimer(kind, effect);
      return;
    }
    installTimer(kind, activeClaim.generation, deadline, effect);
  };

  const schedule = (kind: CanvasEffectKind, duration: number, clear: () => void) => {
    scheduleAt(kind, Date.now() + duration, clear);
  };

  const handBackBaselineTimers = (
    kinds: Iterable<CanvasChannelKind>,
    handedBackKinds: Set<CanvasEffectKind>,
  ): void => {
    for (const kind of kinds) {
      if (!isCanvasEffectKind(kind)) continue;
      const lease = baselineTimerLeases.get(kind);
      if (!lease) continue;

      const suspended = suspendedCanvasTimerLeases.get(kind);
      if (!suspended?.includes(lease)) continue;

      // A newer owner may have claimed the channel while this owner was
      // restoring. Never take that projection back; leave the suspended lease
      // for the eventual owner that still has a matching baseline.
      const active = activeCanvasClaims.get(kind);
      if (active && active.ownerId !== ownerId) continue;

      // Drop this owner's temporary claim/timer before handing ownership to
      // the original owner. No visual write occurs in this small handoff.
      if (active?.ownerId === ownerId) {
        const temporaryLease = activeCanvasTimerLeases.get(kind);
        if (temporaryLease) clearTimeout(temporaryLease.handle);
        activeCanvasTimerLeases.delete(kind);
        const localTimer = timers.get(kind);
        if (localTimer && localTimer.generation === active.generation) {
          clearTimeout(localTimer.handle);
          timers.delete(kind);
        }
        activeCanvasClaims.delete(kind);
        ownedKinds.delete(kind);
      }

      removeSuspendedLease(lease);
      const generation = nextCanvasGeneration++;
      if (!lease.resume(generation)) {
        throw new Error(`Canvas ${kind} timer lease could not be resumed`);
      }
      handedBackKinds.add(kind);
    }
  };

  const clearExpiredBaselineTimer = (kind: CanvasEffectKind): void => {
    const active = activeCanvasClaims.get(kind);
    if (active && active.ownerId !== ownerId) {
      throw new Error(`Canvas ${kind} channel was lost during expired baseline cleanup`);
    }
    if (active) {
      expireCurrentTimer(kind, {
        clear: () => clearCanvasEffect(kind),
        settled: false,
      });
      return;
    }
    clearCanvasEffect(kind);
  };

  const handBackBaselineChannels = (
    kinds: Iterable<CanvasChannelKind>,
    handedBackTimerKinds: ReadonlySet<CanvasEffectKind>,
  ): void => {
    for (const kind of kinds) {
      const baselineOwnerId = baselineChannelOwnerIds.get(kind);
      if (baselineOwnerId === undefined) continue;
      if (isCanvasEffectKind(kind) && handedBackTimerKinds.has(kind)) continue;

      const active = activeCanvasClaims.get(kind);
      if (active?.ownerId === baselineOwnerId) continue;
      if (active && active.ownerId !== ownerId) continue;

      const registration = canvasOwnerRegistrations.get(baselineOwnerId);
      const generation = nextCanvasGeneration++;
      if (!registration?.acceptRestoredChannel(kind, generation)) {
        throw new Error(`Canvas ${kind} channel ownership could not be restored`);
      }
      ownedKinds.delete(kind);
    }
  };

  const baselineChannel = (kind: CanvasChannelKind): CanvasBaselineChannel | null => {
    if (!baseline) return null;
    return {
      snapshot: cloneCanvasSnapshot(baseline),
      ownerId: baselineChannelOwnerIds.get(kind),
      timerLease: isCanvasEffectKind(kind) ? baselineTimerLeases.get(kind) : undefined,
    };
  };

  const rebaseBaselineChannel = (
    kind: CanvasChannelKind,
    removedOwnerId: number,
    replacement: CanvasBaselineChannel,
  ): void => {
    if (
      !baseline ||
      !mutatedKinds.has(kind) ||
      baselineChannelOwnerIds.get(kind) !== removedOwnerId
    ) {
      return;
    }
    copyCanvasChannel(baseline, replacement.snapshot, kind);
    if (replacement.ownerId === undefined) baselineChannelOwnerIds.delete(kind);
    else baselineChannelOwnerIds.set(kind, replacement.ownerId);
    if (isCanvasEffectKind(kind)) {
      if (replacement.timerLease) baselineTimerLeases.set(kind, replacement.timerLease);
      else baselineTimerLeases.delete(kind);
    }
  };

  const acceptRestoredChannel = (kind: CanvasChannelKind, generation: number): boolean => {
    if (disposed) return false;
    if (isCanvasEffectKind(kind)) retainedTimerKinds.delete(kind);
    activeCanvasClaims.set(kind, { ownerId, generation });
    latestCanvasChannelGenerations.set(kind, generation);
    latestOwnedGenerations.set(kind, generation);
    ownedKinds.add(kind);
    mutatedKinds.add(kind);
    updateExpectedChannels([kind]);
    return true;
  };

  const rebaseCoveringOwners = (): void => {
    for (const kind of mutatedKinds) {
      const replacement = baselineChannel(kind);
      if (!replacement) continue;
      for (const [candidateId, registration] of canvasOwnerRegistrations) {
        if (candidateId === ownerId) continue;
        registration.rebaseBaselineChannel(kind, ownerId, replacement);
      }
    }
  };

  const restoreBaseline = () => {
    if (disposed || !baseline) return;
    const current = capture();
    const baselineSnapshot = baseline;
    const timerGenerationsBefore = new Map(
      [...timers.entries()].map(([kind, timer]) => [kind, timer.generation] as const),
    );
    const restorableKinds = expected
      ? [...mutatedKinds].filter((kind) => channelStateEqual(current, expected!, kind))
      : [];
    const skippedKinds = [...mutatedKinds].filter((kind) => !restorableKinds.includes(kind));
    const expiredBaselineTimerKinds = restorableKinds.filter(
      (kind): kind is CanvasEffectKind =>
        isCanvasEffectKind(kind) &&
        baselineTimerLeases.has(kind) &&
        baselineTimerLeases.get(kind)!.deadline <= Date.now(),
    );
    const channelRestoreKinds = restorableKinds.filter(
      (kind) => !expiredBaselineTimerKinds.includes(kind as CanvasEffectKind),
    );
    const handedBackTimerKinds = new Set<CanvasEffectKind>();

    const errors: unknown[] = [];
    // If this layer is hidden by a newer owner, splice our real pre-image into
    // that owner's baseline before removing our timer lease. This is the
    // non-LIFO equivalent of popping adjacent layers from a presentation stack.
    rebaseCoveringOwners();
    try {
      // An already-expired covered timer settles against the currently visible
      // image. Publishing its old baseline first would leak a dead overlay to
      // synchronous Canvas subscribers, even if it were cleared immediately.
      handBackBaselineTimers(expiredBaselineTimerKinds, handedBackTimerKinds);
    } catch (cause) {
      errors.push(cause);
    }
    for (const kind of expiredBaselineTimerKinds) {
      if (handedBackTimerKinds.has(kind)) continue;
      try {
        // The baseline lease may already have settled or been invalidated by
        // an interleaved owner. Its expired image is still authoritative, so
        // clear this owner's projection without resurrecting the old overlay.
        clearExpiredBaselineTimer(kind);
      } catch (cause) {
        errors.push(cause);
      }
    }
    try {
      // Restore channels independently. A concurrent writer on spotlight must
      // not prevent a safe highlight rollback, nor should it be clobbered by
      // restoring the complete process-wide Canvas image.
      if (channelRestoreKinds.length > 0) {
        restoreChannels(baselineSnapshot!, channelRestoreKinds);
      }
    } catch (cause) {
      errors.push(cause);
    }
    try {
      handBackBaselineTimers(channelRestoreKinds, handedBackTimerKinds);
    } catch (cause) {
      errors.push(cause);
    }
    try {
      handBackBaselineChannels(channelRestoreKinds, handedBackTimerKinds);
    } catch (cause) {
      errors.push(cause);
    }
    for (const kind of skippedKinds) {
      // A newer writer won the CAS. Invalidate this owner's timers/claims so
      // their callbacks cannot clear that newer projection later.
      try {
        cancel(kind);
      } catch (cause) {
        errors.push(cause);
      }
    }
    baseline = null;
    expected = null;
    mutatedKinds.clear();
    latestOwnedGenerations.clear();
    baselineTimerLeases.clear();
    baselineChannelOwnerIds.clear();
    if (baselineSnapshot) {
      for (const kind of CANVAS_EFFECT_KINDS) {
        if (
          baselineSnapshot.timerRemainingMs[kind] !== undefined &&
          baselineSnapshot.timerRemainingMs[kind]! > 0 &&
          timers.get(kind)?.generation !== undefined &&
          timers.get(kind)?.generation !== timerGenerationsBefore.get(kind)
        ) {
          retainedTimerKinds.add(kind);
        }
      }
    }
    throwCanvasErrors(errors, 'Canvas presentation baseline restore failed');
  };

  const dispose = () => {
    if (disposed) return;
    let failure: unknown;
    try {
      restoreBaseline();
    } catch (cause) {
      failure = cause;
    } finally {
      for (const kind of [...timers.keys()]) {
        if (!retainedTimerKinds.has(kind)) cancel(kind);
      }
      for (const kind of [...ownedKinds]) {
        if (!isCanvasEffectKind(kind) || !retainedTimerKinds.has(kind)) cancel(kind);
      }
      for (const kind of CANVAS_EFFECT_KINDS) removeSuspendedLeasesForOwner(kind);
      baselineTimerLeases.clear();
      baselineChannelOwnerIds.clear();
      canvasOwnerRegistrations.delete(ownerId);
      disposed = true;
    }
    if (failure) throw failure;
  };

  canvasOwnerRegistrations.set(ownerId, {
    baselineChannel,
    acceptRestoredChannel,
    rebaseBaselineChannel,
  });

  return {
    capture,
    restore,
    canRestoreIfCurrent,
    restoreIfCurrent,
    beginMutation,
    endMutation,
    claim,
    isCurrent,
    cancel,
    schedule,
    restoreBaseline,
    dispose,
  };
}

const defaultCanvasPresentationOwner = createCanvasPresentationOwner({ trackBaseline: false });

/**
 * Create the canvas operations API
 *
 * @param store - Zustand store instance
 * @returns Canvas namespace API
 */
export interface CanvasAPIOptions {
  /** Optional owner used by transactional teaching presentation. */
  readonly presentationOwner?: CanvasPresentationOwner;
}

export function createCanvasAPI(store: StageStore, options: CanvasAPIOptions = {}) {
  const presentationOwner = options.presentationOwner ?? defaultCanvasPresentationOwner;

  const claimEffects = (...kinds: CanvasChannelKind[]) => {
    // Capture the complete Canvas pre-image before invalidating a timer or
    // changing an overlay.  The session-level applier also calls
    // `beginMutation`; the owner makes that duplicate call idempotent.
    presentationOwner.beginMutation();
    for (const kind of kinds) presentationOwner.claim(kind);
  };

  const scheduleClear = (
    kind: CanvasEffectKind,
    duration: number | undefined,
    clear: () => void,
  ) => {
    if (duration && duration > 0) {
      presentationOwner.schedule(kind, duration, clear);
    }
  };

  return {
    /**
     * Set background
     *
     * @param sceneId - Scene ID
     * @param background - Background settings
     * @returns Whether successful
     */
    setBackground(sceneId: string, background: SlideBackground): APIResult<boolean> {
      try {
        const state = store.getState();
        const scene = getScene(state.scenes, sceneId);

        if (!scene || scene.type !== 'slide') {
          return { success: false, error: 'Invalid scene' };
        }

        const content = scene.content as SlideContent;

        const newScenes = state.scenes.map((s) => {
          if (s.id === sceneId) {
            return {
              ...s,
              content: {
                ...content,
                canvas: {
                  ...content.canvas,
                  background,
                },
              },
              updatedAt: Date.now(),
            };
          }
          return s;
        });

        store.setState({ scenes: newScenes });

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Set theme
     *
     * @param sceneId - Scene ID
     * @param theme - Theme settings
     * @returns Whether successful
     */
    setTheme(sceneId: string, theme: Partial<SlideTheme>): APIResult<boolean> {
      try {
        const state = store.getState();
        const scene = getScene(state.scenes, sceneId);

        if (!scene || scene.type !== 'slide') {
          return { success: false, error: 'Invalid scene' };
        }

        const content = scene.content as SlideContent;

        const newScenes = state.scenes.map((s) => {
          if (s.id === sceneId) {
            return {
              ...s,
              content: {
                ...content,
                canvas: {
                  ...content.canvas,
                  theme: {
                    ...content.canvas.theme,
                    ...theme,
                  },
                },
              },
              updatedAt: Date.now(),
            };
          }
          return s;
        });

        store.setState({ scenes: newScenes });

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Highlight an element (teaching feature)
     *
     * Emphasize an element by adding a highlight border or shadow
     *
     * @param sceneId - Scene ID
     * @param elementId - Element ID
     * @param options - Highlight options
     * @returns Whether successful
     */
    highlight(
      sceneId: string,
      elementId: string,
      options: HighlightOptions = {},
    ): APIResult<boolean> {
      const { duration, color = '#ff6b6b', style = 'outline' } = options;

      try {
        // Use the new Canvas Store highlight overlay API
        // Advantage: does not modify the element itself, purely visual effect
        const canvasStore = useCanvasStore.getState();
        // Claim this channel before writing. This invalidates any timer from a
        // previous action, so an old callback cannot clear the new overlay.
        claimEffects('highlight');
        canvasStore.setHighlight([elementId], {
          color,
          opacity: style === 'fill' ? 0.3 : 0.5,
          borderWidth: 3,
          animated: true,
        });

        // If duration is set, automatically clear the highlight
        scheduleClear('highlight', duration, () => {
          canvasStore.clearHighlight();
        });

        // Direct Canvas API callers (for example PlaybackEngine actions) do
        // not have the session applier's commit/rollback hook.  Close the
        // mutation here so the owner records the post-write image and can
        // later restore its baseline on dispose.
        presentationOwner.endMutation();

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Spotlight effect (teaching feature)
     *
     * Highlight a specific element while dimming everything else
     * Note: this requires a mask layer in the frontend rendering layer
     *
     * @param sceneId - Scene ID
     * @param elementId - Element ID
     * @param options - Spotlight options
     * @returns Whether successful
     */
    spotlight(
      sceneId: string,
      elementId: string,
      options: SpotlightOptions = {},
    ): APIResult<boolean> {
      try {
        // Use Canvas Store's spotlight API
        const canvasStore = useCanvasStore.getState();
        claimEffects('spotlight');
        canvasStore.setSpotlight(elementId, options);

        // If duration is set, automatically clear the spotlight
        scheduleClear('spotlight', options.duration, () => {
          canvasStore.clearSpotlight();
        });

        presentationOwner.endMutation();

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Clear all highlight and spotlight effects
     *
     * @param sceneId - Scene ID
     * @returns Whether successful
     */
    clearHighlights(_sceneId: string): APIResult<boolean> {
      try {
        // Use Canvas Store to clear all teaching effects
        const canvasStore = useCanvasStore.getState();
        claimEffects('highlight', 'spotlight');
        canvasStore.clearHighlight();
        canvasStore.clearSpotlight();

        presentationOwner.endMutation();

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Clear spotlight effect
     *
     * @returns Whether successful
     */
    clearSpotlight(_sceneId?: string): APIResult<boolean> {
      try {
        const canvasStore = useCanvasStore.getState();
        claimEffects('spotlight');
        canvasStore.clearSpotlight();
        presentationOwner.endMutation();
        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Set percentage-mode spotlight
     *
     * @param sceneId - Scene ID
     * @param elementId - Element ID
     * @param geometry - Percentage geometry info
     * @param options - Spotlight options
     * @returns Whether successful
     */
    setSpotlightPercentage(
      sceneId: string,
      elementId: string,
      geometry: import('@/lib/types/action').PercentageGeometry,
      options: SpotlightOptions = {},
    ): APIResult<boolean> {
      try {
        const canvasStore = useCanvasStore.getState();
        claimEffects('spotlight');
        canvasStore.setSpotlightPercentage(elementId, geometry, options);

        scheduleClear('spotlight', options.duration, () => {
          canvasStore.clearSpotlight();
        });

        presentationOwner.endMutation();

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Set laser pointer effect
     *
     * @param sceneId - Scene ID
     * @param elementId - Element ID
     * @param geometry - Percentage geometry info
     * @param options - Laser pointer options
     * @returns Whether successful
     */
    setLaser(
      sceneId: string,
      elementId: string,
      geometry: import('@/lib/types/action').PercentageGeometry,
      options: import('@/lib/store/canvas').LaserOptions = {},
    ): APIResult<boolean> {
      try {
        const canvasStore = useCanvasStore.getState();
        claimEffects('laser');
        canvasStore.setLaser(elementId, options);

        scheduleClear('laser', options.duration, () => {
          canvasStore.clearLaser();
        });

        presentationOwner.endMutation();

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Clear laser pointer effect
     *
     * @param sceneId - Scene ID
     * @returns Whether successful
     */
    clearLaser(_sceneId: string): APIResult<boolean> {
      try {
        const canvasStore = useCanvasStore.getState();
        claimEffects('laser');
        canvasStore.clearLaser();
        presentationOwner.endMutation();
        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Set zoom effect
     *
     * @param sceneId - Scene ID
     * @param elementId - Element ID
     * @param geometry - Percentage geometry info
     * @param scale - Zoom scale
     * @returns Whether successful
     */
    setZoom(
      sceneId: string,
      elementId: string,
      geometry: import('@/lib/types/action').PercentageGeometry,
      scale: number,
    ): APIResult<boolean> {
      try {
        const canvasStore = useCanvasStore.getState();
        claimEffects('zoom');
        canvasStore.setZoom(elementId, scale);
        presentationOwner.endMutation();
        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Clear zoom effect
     *
     * @param sceneId - Scene ID
     * @returns Whether successful
     */
    clearZoom(_sceneId: string): APIResult<boolean> {
      try {
        const canvasStore = useCanvasStore.getState();
        claimEffects('zoom');
        canvasStore.clearZoom();
        presentationOwner.endMutation();
        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Clear all visual effects (spotlight, laser, zoom, etc.)
     *
     * @param sceneId - Scene ID
     * @returns Whether successful
     */
    clearAllEffects(_sceneId: string): APIResult<boolean> {
      try {
        const canvasStore = useCanvasStore.getState();
        // Clear each presentation channel explicitly. The store-level helper
        // also resets editor-only `pickTarget`; replay cleanup must not touch
        // that unrelated interaction state, and zoom needs its own claim so a
        // superseded owner's cleanup cannot win the channel race.
        claimEffects('highlight', 'spotlight', 'laser', 'zoom');
        canvasStore.clearHighlight();
        canvasStore.clearSpotlight();
        canvasStore.clearLaser();
        canvasStore.clearZoom();
        presentationOwner.endMutation();
        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },

    /**
     * Highlight multiple elements in batch
     *
     * @param sceneId - Scene ID
     * @param elementIds - Element ID list
     * @param options - Highlight options
     * @returns Whether successful
     */
    highlightMultiple(
      sceneId: string,
      elementIds: string[],
      options: HighlightOptions = {},
    ): APIResult<boolean> {
      const { duration, color = '#ff6b6b' } = options;

      try {
        const canvasStore = useCanvasStore.getState();
        claimEffects('highlight');
        canvasStore.setHighlight(elementIds, {
          color,
          opacity: 0.3,
          borderWidth: 3,
          animated: true,
        });

        scheduleClear('highlight', duration, () => {
          canvasStore.clearHighlight();
        });

        presentationOwner.endMutation();

        return { success: true, data: true };
      } catch (error) {
        return { success: false, error: String(error) };
      }
    },
  };
}
