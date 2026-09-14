'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { createStagePresentationStore, type StagePresentationStore } from '@/lib/api/stage-api';
import { createLogger } from '@/lib/logger';

const log = createLogger('ReplayPresentationBoundary');

const REQUEST_BOUNDARY_DISPOSE = Symbol('requestReplayBoundaryDispose');
const ATTACH_BOUNDARY_DISPOSER = Symbol('attachReplayBoundaryDisposer');

type InternalReplayPresentationBridge = ReplayPresentationBridge & {
  [REQUEST_BOUNDARY_DISPOSE]?: () => void;
  [ATTACH_BOUNDARY_DISPOSER]?: (dispose: () => void) => void;
};

interface ReplayPresentationTurn {
  readonly ready: Promise<void>;
  release: () => void;
}

/**
 * Replay adapters project into one process-wide Stage/Canvas surface. Keep a
 * module-wide FIFO turn so a newly mounted Boundary cannot capture an older
 * replay projection as its canonical baseline while that replay is still
 * draining W cleanup. The reservation is made in a committed effect, avoiding
 * leaks from abandoned concurrent renders.
 */
let replayPresentationTurnTail: Promise<void> = Promise.resolve();

function reserveReplayPresentationTurn(): ReplayPresentationTurn {
  const ready = replayPresentationTurnTail;
  let resolveRelease!: () => void;
  const released = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  replayPresentationTurnTail = ready.then(() => released);
  let didRelease = false;
  return {
    ready,
    release: () => {
      if (didRelease) return;
      didRelease = true;
      resolveRelease();
    },
  };
}

export interface ReplayEngineControls {
  /** Start the currently presented replay node (or queue until its engine mounts). */
  start: (
    targetNodeId?: string,
    options?: { paused?: boolean; requestGeneration?: number },
  ) => void | Promise<void>;
  /** Freeze the local PlaybackEngine. */
  pause: () => void | Promise<void>;
  /** Release a paused local PlaybackEngine. */
  resume: () => void | Promise<void>;
  /** Restart the current replay node from its beginning. */
  retry: () => void | Promise<void>;
  /** Stop local playback when a replay command fails. */
  stop: () => void | Promise<void>;
}

export interface ReplayPresentationBridge {
  advance?: (expectedNodeId?: string) => Promise<{
    advanced: boolean;
    ended: boolean;
    nodeId?: string;
    positionMismatch?: boolean;
  }>;
  navigate?: (targetNodeId: string) => Promise<{
    advanced: boolean;
    ended: boolean;
    nodeId?: string;
    positionMismatch?: boolean;
  }>;
  complete?: () => void;
  fail?: () => Promise<void>;
  /** Local PlaybackEngine controls, registered by PlaybackChromeRoot. */
  engineControls?: ReplayEngineControls;
  /** Resolve once the replay PlaybackEngine control port has mounted. */
  waitForEngineControls?: () => Promise<ReplayEngineControls>;
  /** A deferred engine start completed for the supplied Host request. */
  reportPlaybackStarted?: (requestGeneration: number) => void;
  /** A deferred engine start failed for the supplied Host request. */
  reportPlaybackFailure?: (requestGeneration: number, cause?: unknown) => Promise<void>;
  /** Register/unregister the current local control port. */
  registerEngineControls?: (controls: ReplayEngineControls) => void;
  unregisterEngineControls?: (controls: ReplayEngineControls) => void;
  /** Monotonic identity of the currently registered engine control port. */
  getEngineControlsGeneration?: () => number;
  /** Reject pending control waits when the replay boundary truly unmounts. */
  cancelEngineControlWaiters?: () => void;
  /**
   * Keep the presentation adapter alive until an asynchronous replay cleanup
   * has finished.  The Host registers its W/controller cleanup during child
   * effect teardown; the Boundary then disposes only after all registered
   * cleanups settle.
   */
  trackReplayCleanup?: (cleanup: Promise<unknown>) => void;
  /** Whether a scene is inside the replay's persisted taught range. */
  canNavigate?: (nodeId: string) => boolean;
  /** Controller + engine coordinated pause command, registered by Host. */
  pauseReplay?: () => Promise<void>;
  /** Controller + engine coordinated resume command, registered by Host. */
  resumeReplay?: () => Promise<void>;
  /** Controller + engine coordinated retry command, registered by Host. */
  retryReplay?: () => Promise<void>;
  /** Controller + engine coordinated initial-start command, registered by Host. */
  startReplay?: (targetNodeId?: string, options?: { paused?: boolean }) => Promise<void>;
}

/**
 * Owns the one presentation adapter shared by the replay Stage and its
 * controller host. The adapter is intentionally lazy: a render that React
 * abandons cannot leave a persistence fence behind before a committed replay
 * actually mutates the canonical view.
 *
 * Cleanup is deferred to a microtask and guarded by a mount count. React
 * StrictMode performs a synthetic cleanup/setup pair while the component is
 * still mounted; disposing during that pair would leave the second setup with
 * a dead adapter. A real unmount reaches a zero count and disposes normally.
 */
export function ReplayPresentationBoundary({
  children,
}: {
  children: (context: {
    presentationStore: StagePresentationStore;
    replayBridge: ReplayPresentationBridge;
  }) => ReactNode;
}) {
  const [turnReady, setTurnReady] = useState(false);
  const [presentationStore] = useState(() => createStagePresentationStore({ fence: 'lazy' }));
  const [replayBridge] = useState<ReplayPresentationBridge>(() => {
    const waiters = new Set<{
      resolve: (controls: ReplayEngineControls) => void;
      reject: (error: Error) => void;
    }>();
    const bridge: InternalReplayPresentationBridge = {};
    let cancelled = false;
    let controlsGeneration = 0;
    let disposed = false;
    const pendingCleanups = new Set<Promise<unknown>>();
    let boundaryUnmountRequested = false;
    let disposeAdapter: (() => void) | null = null;
    let terminationPromise: Promise<void> = Promise.resolve();

    const reportTerminationFailure = (context: string, cause: unknown): void => {
      try {
        log.error(`[ReplayPresentationBoundary] ${context}:`, cause);
      } catch (loggingCause) {
        // Logging is not allowed to turn an already-observed lifecycle failure
        // into another unhandled rejection. Keep the original cause visible
        // through the platform console if a custom logger is unavailable.
        try {
          console.error(`[ReplayPresentationBoundary] ${context}:`, cause, loggingCause);
        } catch {
          // Both configured logging channels rejected the same already-observed
          // failure. There is no third reporting boundary to call safely.
        }
      }
    };

    const observeTermination = (promise: Promise<unknown>, context: string): Promise<void> => {
      const observed = Promise.resolve(promise).then(
        () => undefined,
        (cause) => {
          reportTerminationFailure(context, cause);
        },
      );
      // `reportTerminationFailure` is best effort, but keep a final observer
      // attached as a hard guard if a future logger implementation throws.
      return observed.catch((cause) => {
        reportTerminationFailure(`termination observer failed (${context})`, cause);
      });
    };

    const enqueueTermination = (operation: () => void | Promise<void>, context: string): void => {
      const next = terminationPromise.then(() => operation());
      terminationPromise = observeTermination(next, context);
    };

    const maybeDisposeTracked = () => {
      if (!boundaryUnmountRequested || disposed || pendingCleanups.size > 0) {
        return;
      }
      if (!disposeAdapter) return;
      disposed = true;
      enqueueTermination(disposeAdapter, 'presentation dispose failed');
    };

    bridge.trackReplayCleanup = (cleanup) => {
      const tracked = Promise.resolve(cleanup);
      if (disposed) {
        void observeTermination(tracked, 'late replay cleanup failed');
        return;
      }
      const observed = observeTermination(tracked, 'replay cleanup failed');
      pendingCleanups.add(observed);
      const bookkeeping = observed.then(() => {
        pendingCleanups.delete(observed);
        maybeDisposeTracked();
      });
      terminationPromise = observeTermination(
        terminationPromise.then(() => bookkeeping),
        'replay cleanup termination',
      );
    };

    bridge[ATTACH_BOUNDARY_DISPOSER] = (dispose) => {
      disposeAdapter = dispose;
      maybeDisposeTracked();
    };
    bridge[REQUEST_BOUNDARY_DISPOSE] = () => {
      if (boundaryUnmountRequested) return;
      boundaryUnmountRequested = true;
      // Reject control waiters as soon as the real boundary unmount starts;
      // otherwise a Host cleanup waiting for an engine port could deadlock the
      // disposal path indefinitely.
      bridge.cancelEngineControlWaiters?.();
      maybeDisposeTracked();
    };

    bridge.waitForEngineControls = () => {
      if (bridge.engineControls) return Promise.resolve(bridge.engineControls);
      if (cancelled) {
        const rejected = Promise.reject(new Error('Replay presentation boundary unmounted'));
        void rejected.catch(() => undefined);
        return rejected;
      }
      const pending = new Promise<ReplayEngineControls>((resolve, reject) => {
        const waiter = { resolve, reject };
        waiters.add(waiter);
      });
      // The Host normally observes this rejection, but keep an internal
      // observer as well so a consumer that abandons a wait during unmount
      // cannot create a process-level unhandled rejection.
      void pending.catch(() => undefined);
      return pending;
    };
    bridge.registerEngineControls = (controls) => {
      if (cancelled) return;
      bridge.engineControls = controls;
      controlsGeneration += 1;
      for (const waiter of waiters) waiter.resolve(controls);
      waiters.clear();
    };
    bridge.unregisterEngineControls = (controls) => {
      if (bridge.engineControls !== controls) return;
      bridge.engineControls = undefined;
      controlsGeneration += 1;
    };
    bridge.getEngineControlsGeneration = () => controlsGeneration;
    bridge.cancelEngineControlWaiters = () => {
      if (cancelled) return;
      cancelled = true;
      const error = new Error('Replay presentation boundary unmounted');
      for (const waiter of waiters) waiter.reject(error);
      waiters.clear();
    };

    return bridge;
  });
  const mountCountRef = useRef(0);
  const activeStoreRef = useRef<StagePresentationStore | null>(null);
  const turnRef = useRef<ReplayPresentationTurn | null>(null);

  useEffect(() => {
    activeStoreRef.current = presentationStore;
    mountCountRef.current += 1;
    const turn = turnRef.current ?? reserveReplayPresentationTurn();
    turnRef.current = turn;

    const internalBridge = replayBridge as InternalReplayPresentationBridge;
    internalBridge[ATTACH_BOUNDARY_DISPOSER]?.(() => {
      try {
        if (!presentationStore.presentation.isDisposed()) {
          presentationStore.presentation.dispose();
        }
      } finally {
        turn.release();
      }
    });
    void turn.ready.then(() => {
      if (
        activeStoreRef.current === presentationStore &&
        mountCountRef.current > 0 &&
        !presentationStore.presentation.isDisposed()
      ) {
        setTurnReady(true);
      }
    });

    return () => {
      mountCountRef.current -= 1;
      queueMicrotask(() => {
        const isCurrentStore = activeStoreRef.current === presentationStore;
        if (!isCurrentStore || mountCountRef.current === 0) {
          internalBridge[REQUEST_BOUNDARY_DISPOSE]?.();
          if (isCurrentStore && presentationStore.presentation.isDisposed()) {
            activeStoreRef.current = null;
          }
        }
      });
    };
  }, [presentationStore, replayBridge]);

  return turnReady ? children({ presentationStore, replayBridge }) : null;
}
