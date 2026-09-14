'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { GameLoader } from '@/components/livecourse/GameLoader';
import type { StagePresentationStore } from '@/lib/api/stage-api';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import {
  createTeachingActionRepository,
  type TeachingActionRepository,
} from '@/lib/livecourse/session/action-repository';
import {
  ClassroomPresentationCommitError,
  createReplaySessionController,
  ReplayAppendUncertaintyError,
  type ReplaySessionController,
  type ReplaySessionState,
} from '@/lib/livecourse/session/controller';
import {
  pauseReplayPlayback,
  resumeReplayPlayback,
  retryReplayPlayback,
} from '@/lib/livecourse/session/replay-playback-control';
import { createCourseStateRepository } from '@/lib/livecourse/session/course-state-repository';
import {
  createTeachingPresentationApplier,
  resolveLessonPlan,
} from '@/lib/livecourse/session/context';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';
import { useStageStore } from '@/lib/store';
import type { ReplayEngineControls, ReplayPresentationBridge } from './ReplayPresentationBoundary';

const log = createLogger('LiveCourseReplay');

type HostState = ReplaySessionState | 'boot' | 'load-failed';

interface ReplayOwner {
  generation: number;
  readonly controller: ReplaySessionController;
  readonly repository: TeachingActionRepository;
  /** Presentation adapter that created this owner's projection. */
  readonly presentationStore: StagePresentationStore;
  active: boolean;
  /** Generation that claimed this owner for its current cleanup operation. */
  cleanupGeneration?: number;
  engineControls?: ReplayEngineControls;
  /** An append response could not be reconciled; never destroy this W blindly. */
  uncertainAppend: boolean;
  /** W is known durable but local presentation finalization failed. */
  durablePresentation: boolean;
  cleanupPromise?: Promise<void>;
}

interface ReplayCleanupOptions {
  stopEngine: boolean;
  restorePresentation: boolean;
  preserveUncertainty?: boolean;
  failOnError?: boolean;
}

class ReplayOwnerSupersededError extends Error {
  override readonly name = 'ReplayOwnerSupersededError';

  constructor() {
    super('Replay operation was superseded by a newer lifecycle owner');
  }
}

class ReplayOwnerCleanupBlockedError extends Error {
  override readonly name = 'ReplayOwnerCleanupBlockedError';

  constructor() {
    super('Replay owner cleanup is blocked by an unresolved W/presentation action');
  }
}

/**
 * J4.2 / J4.4「再听」宿主（docs/spec/04-detailed-design.md §1/§6）：每次进入都
 * 以全新 replayId 新建独立 replay `W`，播放范围严格取 `C` 持久化的已讲范围
 * （完成课为全课）。加载失败留在发起入口的选择态（由 `onAbort` 返回）；播放
 * 失败保留当前回放位置可重试；「结束重听」销毁 replay `W` 后按入口返回。
 * replay 结构性不写 `C / L`、不新增 `EvidenceRecord`、不重判 `GoalState`。
 */
export function LiveCourseReplayHost({
  courseId,
  lessonId,
  presentationStore,
  onEnd,
  onAbort,
  replayBridge,
}: {
  courseId: string;
  lessonId: string;
  /** Shared adapter owned by the replay boundary and also used by Stage. */
  presentationStore: StagePresentationStore;
  /** 自然结束或「结束重听」销毁 replay W 后按入口返回。 */
  onEnd: () => void;
  /** 加载失败时放弃回放、返回入口选择态。 */
  onAbort: () => void;
  replayBridge: ReplayPresentationBridge;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<HostState>('boot');
  const [position, setPosition] = useState<string | null>(null);
  const [range, setRange] = useState<readonly string[]>([]);
  const [endFailed, setEndFailed] = useState(false);
  const controllerRef = useRef<ReplaySessionController | null>(null);
  const repositoryRef = useRef<TeachingActionRepository | null>(null);
  const ownerRef = useRef<ReplayOwner | null>(null);
  const mountedRef = useRef(false);
  const startGenerationRef = useRef(0);
  const endPromiseRef = useRef<Promise<void> | null>(null);
  const cleanupBarrierRef = useRef<Promise<void>>(Promise.resolve());
  const replayEndNotifiedRef = useRef(false);
  const playbackRequestGenerationRef = useRef(0);
  /**
   * React StrictMode re-runs effects on the same mounted instance.  Keep the
   * effect identity so the synthetic cleanup/setup pair does not tear down a
   * live replay W and immediately create a second one.
   */
  const lifecycleEffectRef = useRef<{
    token: symbol;
    start: () => Promise<void>;
  } | null>(null);
  const deferredPlaybackRequestRef = useRef<{
    owner: ReplayOwner;
    generation: number;
    requestGeneration: number;
  } | null>(null);

  const clearDeferredPlaybackRequest = useCallback((owner?: ReplayOwner): void => {
    const pending = deferredPlaybackRequestRef.current;
    if (!pending || !owner || pending.owner === owner) {
      deferredPlaybackRequestRef.current = null;
    }
  }, []);

  const isCurrentOwner = useCallback(
    (owner: ReplayOwner, generation = owner.generation): boolean =>
      mountedRef.current &&
      owner.active &&
      ownerRef.current === owner &&
      startGenerationRef.current === generation,
    [],
  );

  const waitForEngineControls = useCallback(
    async (owner?: ReplayOwner, generation = owner?.generation): Promise<ReplayEngineControls> => {
      if (owner && !isCurrentOwner(owner, generation)) throw new ReplayOwnerSupersededError();
      const controls = replayBridge.engineControls;
      if (controls) {
        if (owner) {
          owner.engineControls = controls;
        }
        return controls;
      }
      if (replayBridge.waitForEngineControls) {
        const waited = await replayBridge.waitForEngineControls();
        if (owner && !isCurrentOwner(owner, generation)) throw new ReplayOwnerSupersededError();
        // A control port can be replaced while a waiter resolves. Do not let
        // an old port receive commands for the current replay owner. The
        // bridge must still point at the exact port returned by the waiter;
        // accepting an unregistered port would route commands into a stale
        // PlaybackEngine after a scene remount.
        if (replayBridge.engineControls !== waited) {
          throw new ReplayOwnerSupersededError();
        }
        if (owner) {
          owner.engineControls = waited;
        }
        return waited;
      }
      throw new Error('Replay playback engine is not ready');
    },
    [isCurrentOwner, replayBridge],
  );

  const syncControllerState = useCallback(
    async (owner: ReplayOwner): Promise<void> => {
      if (!isCurrentOwner(owner)) return;
      setState(owner.controller.getState());
      try {
        const nextPosition = await owner.controller.getPosition();
        if (isCurrentOwner(owner)) setPosition(nextPosition);
      } catch (cause) {
        if (isCurrentOwner(owner)) {
          log.warn('[LiveCourseReplay] failed to read replay position:', cause);
        }
      }
    },
    [isCurrentOwner],
  );

  const reportDeferredPlaybackFailure = useCallback(
    async (requestGeneration: number, cause?: unknown): Promise<void> => {
      const pending = deferredPlaybackRequestRef.current;
      if (
        !pending ||
        pending.requestGeneration !== requestGeneration ||
        !isCurrentOwner(pending.owner, pending.generation)
      ) {
        // A late engine callback belongs to a superseded request.  It must not
        // change the state of a newer replay owner.
        return;
      }
      deferredPlaybackRequestRef.current = null;
      try {
        const currentState = pending.owner.controller.getState();
        if (currentState !== 'failed' && currentState !== 'loading' && currentState !== 'ended') {
          await pending.owner.controller.notifyPlaybackFailure();
        }
        await syncControllerState(pending.owner);
      } catch (failureCause) {
        log.warn('[LiveCourseReplay] failed to retain deferred playback failure:', failureCause);
      }
      if (cause) log.warn('[LiveCourseReplay] deferred replay engine start failed:', cause);
    },
    [isCurrentOwner, syncControllerState],
  );

  const reportDeferredPlaybackStarted = useCallback(
    (requestGeneration: number): void => {
      const pending = deferredPlaybackRequestRef.current;
      if (
        pending?.requestGeneration === requestGeneration &&
        isCurrentOwner(pending.owner, pending.generation)
      ) {
        deferredPlaybackRequestRef.current = null;
      }
    },
    [isCurrentOwner],
  );

  const markReplayBoundaryFailure = useCallback((owner: ReplayOwner, cause: unknown): void => {
    if (cause instanceof ReplayAppendUncertaintyError) owner.uncertainAppend = true;
    if (cause instanceof ClassroomPresentationCommitError) owner.durablePresentation = true;
  }, []);

  const startReplayEngine = useCallback(
    async (
      owner: ReplayOwner,
      generation: number,
      controls: ReplayEngineControls,
      targetNodeId?: string,
      options: { paused?: boolean } = {},
    ): Promise<void> => {
      if (!isCurrentOwner(owner, generation)) throw new ReplayOwnerSupersededError();
      const requestGeneration = ++playbackRequestGenerationRef.current;
      deferredPlaybackRequestRef.current = { owner, generation, requestGeneration };
      try {
        await controls.start(targetNodeId, { ...options, requestGeneration });
      } catch (cause) {
        if (deferredPlaybackRequestRef.current?.requestGeneration === requestGeneration) {
          deferredPlaybackRequestRef.current = null;
        }
        throw cause;
      }
    },
    [isCurrentOwner],
  );

  const resolveOwnedEngineControls = useCallback(
    (owner: ReplayOwner): ReplayEngineControls | undefined => {
      // A PlaybackChromeRoot remount can replace the control port while the
      // replay owner itself remains alive.  Prefer the bridge's current port
      // so cleanup never stops a stale engine.  A cached port is only a
      // fallback while the Host is unmounting and the bridge has already
      // unregistered the port.
      const ownsEnginePort =
        ownerRef.current === owner || (!mountedRef.current && ownerRef.current === null);
      if (!ownsEnginePort) return undefined;
      return replayBridge.engineControls ?? owner.engineControls;
    },
    [replayBridge],
  );

  const restorePresentation = useCallback(
    (store: StagePresentationStore = presentationStore) => {
      // The boundary, not this host, owns adapter disposal. Restoring here is
      // still required before an end/failed-start path can reveal the live
      // classroom again; the boundary's eventual dispose remains idempotent.
      try {
        store.presentation.restore();
      } catch (cause) {
        // A restore failure is a lifecycle boundary failure. Log it for the
        // visible error channel, then rethrow so callers can prevent a new W
        // from being created over an unknown canonical projection.
        log.error('[LiveCourseReplay] failed to restore presentation state:', cause);
        throw cause;
      }
    },
    [presentationStore],
  );

  const restorePresentationForOwner = useCallback(
    (owner: ReplayOwner): void => {
      // Cleanup deliberately marks the owner inactive before awaiting engine/W
      // work. Identity is therefore the primary CAS guard; cleanupGeneration
      // records the lifecycle transition that claimed it so a stale owner
      // cannot restore after a newer generation has taken over.
      if (
        !mountedRef.current ||
        ownerRef.current !== owner ||
        owner.active ||
        (owner.cleanupGeneration !== undefined &&
          owner.cleanupGeneration !== startGenerationRef.current)
      ) {
        throw new ReplayOwnerSupersededError();
      }
      restorePresentation(owner.presentationStore);
    },
    [restorePresentation],
  );

  const cleanupReplayWork = useCallback(
    async (owner: ReplayOwner, options: ReplayCleanupOptions): Promise<void> => {
      if (owner.cleanupPromise) return owner.cleanupPromise;
      owner.active = false;
      owner.cleanupGeneration = startGenerationRef.current;
      // Once cleanup claims the owner, any deferred engine callback belongs to
      // a dead request. Clear it before awaiting stop/end so a late callback
      // cannot be accepted if this owner is later reactivated after a failed
      // end attempt.
      clearDeferredPlaybackRequest(owner);

      const cleanup = (async () => {
        const ownsEnginePort =
          ownerRef.current === owner || (!mountedRef.current && ownerRef.current === null);
        const controls = resolveOwnedEngineControls(owner);
        let engineStopSucceeded = true;
        if (options.stopEngine && controls && ownsEnginePort) {
          try {
            await controls.stop();
          } catch (cause) {
            log.warn('[LiveCourseReplay] replay engine cleanup failed:', cause);
            engineStopSucceeded = false;
            if (options.failOnError) throw cause;
          }
        }

        // A failed stop does not prove that the local engine is quiescent. Do
        // not destroy replay W in that case: callbacks from a still-running
        // engine could append against a W that has just been removed.
        if (!engineStopSucceeded) return;

        // Do not destroy or restore across an unresolved replay transaction.
        // A later Retry must reconcile the exact retained action first.
        if (options.restorePresentation) {
          if (
            owner.uncertainAppend ||
            owner.durablePresentation ||
            owner.controller.hasPendingReplayAction() ||
            options.preserveUncertainty
          ) {
            throw new ReplayOwnerCleanupBlockedError();
          }
        }

        let ended = false;
        try {
          await owner.controller.end();
          ended = true;
        } catch (cause) {
          // `end()` rejects while a controller is still loading. In that case
          // direct destruction is safe only when the append outcome is known.
          log.warn('[LiveCourseReplay] controller cleanup failed:', cause);
          markReplayBoundaryFailure(owner, cause);
          if (
            options.failOnError &&
            (owner.uncertainAppend || owner.controller.getState() !== 'loading')
          ) {
            throw cause;
          }
        }

        if (
          !ended &&
          !owner.uncertainAppend &&
          !owner.durablePresentation &&
          !owner.controller.hasPendingReplayAction() &&
          !options.preserveUncertainty
        ) {
          try {
            await owner.repository.destroy();
          } catch (cause) {
            log.warn('[LiveCourseReplay] repository cleanup failed:', cause);
            if (options.failOnError) throw cause;
          }
        }

        // The replay W is the authority for whether this owner can disappear.
        // Restore the shared projection only after W destruction succeeds (or
        // the loading-state repository is explicitly destroyed). Otherwise a
        // failed destroy would leave a stopped engine and live baseline while
        // the retained W still claims to be playing.
        if (options.restorePresentation) restorePresentationForOwner(owner);
      })();
      owner.cleanupPromise = cleanup;
      cleanup.catch(() => {
        if (owner.cleanupPromise === cleanup) owner.cleanupPromise = undefined;
      });
      return cleanup;
    },
    [
      clearDeferredPlaybackRequest,
      markReplayBoundaryFailure,
      resolveOwnedEngineControls,
      restorePresentationForOwner,
    ],
  );

  const scheduleCleanup = useCallback(
    (owner: ReplayOwner, options: ReplayCleanupOptions): Promise<void> => {
      const scheduled = cleanupBarrierRef.current.then(() => cleanupReplayWork(owner, options));
      // The barrier itself must never reject; cleanupReplayWork is best effort,
      // but keep the invariant explicit if a future implementation changes it.
      const settled = scheduled.then(
        () => undefined,
        (cause) => {
          log.warn('[LiveCourseReplay] replay cleanup failed:', cause);
        },
      );
      cleanupBarrierRef.current = settled;
      replayBridge.trackReplayCleanup?.(settled);
      return scheduled;
    },
    [cleanupReplayWork, replayBridge],
  );

  const start = useCallback(async () => {
    // An explicit end owns the current W until it either succeeds or reports
    // a retryable failure. Serialise a concurrent Retry/start behind it so a
    // new owner cannot project a scene while the old owner is still stopping.
    const pendingEnd = endPromiseRef.current;
    if (pendingEnd) await pendingEnd;
    if (!mountedRef.current) return;

    const generation = ++startGenerationRef.current;
    setState('boot');
    setEndFailed(false);
    replayEndNotifiedRef.current = false;

    // Invalidate and drain a previous owner before creating another replay W.
    // This makes rapid Retry/start calls deterministic and prevents an old
    // cleanup from racing the new presentation projection.
    const previousOwner = ownerRef.current;
    let owner: ReplayOwner | null = null;
    let engineStartAttempted = false;
    const retryingRetainedOwner = Boolean(
      previousOwner &&
      (previousOwner.uncertainAppend ||
        previousOwner.durablePresentation ||
        previousOwner.controller.hasPendingReplayAction()) &&
      previousOwner.controller.getState() === 'loading',
    );
    if (retryingRetainedOwner && previousOwner) {
      // A failed idempotency read (or a durable presentation commit failure)
      // leaves the controller in `loading`, but its W may already contain the
      // action. Reuse that exact owner so Retry can reconcile it; creating a
      // fresh replay W here would strand the unknown write and violate the
      // replay boundary.
      previousOwner.generation = generation;
      previousOwner.active = true;
      owner = previousOwner;
      controllerRef.current = previousOwner.controller;
      repositoryRef.current = previousOwner.repository;
    } else if (previousOwner) {
      previousOwner.active = false;
      try {
        // A user-triggered retry must not silently strand the previous W when
        // the local engine could not be stopped.  Propagate that cleanup
        // failure so this owner remains the only reachable retry target.
        await scheduleCleanup(previousOwner, {
          stopEngine: true,
          restorePresentation: true,
          failOnError: true,
        });
      } catch (cause) {
        if (
          ownerRef.current === previousOwner &&
          mountedRef.current &&
          generation === startGenerationRef.current
        ) {
          // Cleanup may have stopped the engine or partially ended W. Keep the
          // exact owner reachable for Retry, but never reactivate it as a
          // writer or report its stale controller state as live playback.
          previousOwner.active = false;
          previousOwner.cleanupGeneration = undefined;
          previousOwner.cleanupPromise = undefined;
          controllerRef.current = previousOwner.controller;
          repositoryRef.current = previousOwner.repository;
          setState('load-failed');
        }
        log.warn('[LiveCourseReplay] previous replay cleanup blocked retry:', cause);
        return;
      }
      if (ownerRef.current === previousOwner && generation === startGenerationRef.current) {
        ownerRef.current = null;
        controllerRef.current = null;
        repositoryRef.current = null;
      }
    }
    if (!mountedRef.current || generation !== startGenerationRef.current) return;

    try {
      const stageId = useStageStore.getState().stage?.id;
      if (!stageId) throw new Error('LiveCourse stage is not ready');
      const learnerId = await getLearnerKey();
      if (!mountedRef.current || generation !== startGenerationRef.current) return;
      const store = getRuntimeStore();
      const courseState = createCourseStateRepository({ store, stageId, learnerId, courseId });
      // 每次「再听」都是独立 replay W：全新 replayId，绝不恢复旧 W。
      if (!owner) {
        const repository = createTeachingActionRepository({
          store,
          stageId,
          learnerId,
          courseId,
          lessonId,
          replayId: crypto.randomUUID(),
        });
        let presentationOwner: ReplayOwner | null = null;
        const applyPresentation = createTeachingPresentationApplier({
          presentationStore,
          assertActive: () => {
            if (
              !mountedRef.current ||
              !presentationOwner ||
              !presentationOwner.active ||
              ownerRef.current !== presentationOwner ||
              presentationOwner.generation !== startGenerationRef.current
            ) {
              throw new ReplayOwnerSupersededError();
            }
          },
        });
        const controller = createReplaySessionController({
          repository,
          loadCourseState: () => courseState.load(),
          applyPresentation,
          courseId,
          lessonId,
        });
        owner = {
          generation,
          controller,
          repository,
          presentationStore,
          active: true,
          uncertainAppend: false,
          durablePresentation: false,
        };
        presentationOwner = owner;
        ownerRef.current = owner;
        controllerRef.current = controller;
        repositoryRef.current = repository;
      }

      const started = await owner.controller.start();
      if (!isCurrentOwner(owner, generation)) {
        await scheduleCleanup(owner, { stopEngine: true, restorePresentation: false });
        return;
      }
      owner.uncertainAppend = false;
      owner.durablePresentation = false;
      // `controller.start()` establishes the replay W cursor. Starting the
      // local engine is a separate failure boundary: if it fails, retain W
      // and expose a retryable playback failure instead of deleting the W.
      const controls = await waitForEngineControls(owner, generation);
      if (!isCurrentOwner(owner, generation)) {
        await scheduleCleanup(owner, { stopEngine: true, restorePresentation: false });
        return;
      }
      owner.engineControls = controls;
      engineStartAttempted = true;
      await startReplayEngine(owner, generation, controls, started.position ?? undefined);
      if (!isCurrentOwner(owner, generation)) {
        await scheduleCleanup(owner, { stopEngine: true, restorePresentation: false });
        return;
      }
      setRange(started.range);
      setPosition(started.position);
      setState(started.state);
    } catch (cause) {
      log.warn('[LiveCourseReplay] start failed:', cause);
      if (!owner) {
        if (mountedRef.current && generation === startGenerationRef.current) {
          setState('load-failed');
        }
        return;
      }

      // Record W-boundary uncertainty before checking owner identity. An
      // unmount/replacement can race the rejected continuation between the
      // append/commit operation and this catch; cleanup still must know that a
      // loading controller may contain a durable (or unresolved) action.
      const appendUncertain = cause instanceof ReplayAppendUncertaintyError;
      const presentationDurable = cause instanceof ClassroomPresentationCommitError;
      markReplayBoundaryFailure(owner, cause);

      if (!isCurrentOwner(owner, generation)) {
        await scheduleCleanup(owner, { stopEngine: true, restorePresentation: false });
        return;
      }

      if (appendUncertain) {
        // Keep the owner/W alive. A subsequent Retry can call controller.start
        // again and reconcile the retained idempotency key without destroying
        // a possibly durable action.
        if (mountedRef.current && generation === startGenerationRef.current) {
          setState('load-failed');
        }
        return;
      }

      if (presentationDurable) {
        // The append has already made this action durable. Keep the same W so
        // Retry can re-present its retained position; never compensate the
        // visible target or mint a second replay session.
        if (mountedRef.current && generation === startGenerationRef.current) {
          setState('load-failed');
        }
        return;
      }

      const startedController = owner.controller.getState() !== 'loading';
      if (startedController) {
        const controls = engineStartAttempted ? resolveOwnedEngineControls(owner) : undefined;
        if (controls) {
          try {
            await controls.stop();
          } catch (stopCause) {
            log.warn(
              '[LiveCourseReplay] failed to stop replay engine after start failure:',
              stopCause,
            );
          }
        }
        try {
          await owner.controller.notifyPlaybackFailure();
        } catch (failureCause) {
          log.warn('[LiveCourseReplay] failed to retain playback failure state:', failureCause);
        }
        await syncControllerState(owner);
        return;
      }

      try {
        await scheduleCleanup(owner, {
          stopEngine: true,
          restorePresentation: true,
          failOnError: true,
        });
      } catch (cleanupCause) {
        // The failed-start owner may still own a partially projected W. Keep
        // that exact owner reachable for Retry when compensation itself fails;
        // never let `void start()` leak this rejection or mint a second W over
        // an unknown canonical projection.
        if (
          ownerRef.current === owner &&
          mountedRef.current &&
          generation === startGenerationRef.current
        ) {
          owner.active = true;
          owner.cleanupGeneration = undefined;
          owner.cleanupPromise = undefined;
          controllerRef.current = owner.controller;
          repositoryRef.current = owner.repository;
          setState('load-failed');
        }
        log.error('[LiveCourseReplay] failed-start replay cleanup blocked:', cleanupCause);
        return;
      }
      // A presentation rollback can fail after reconciliation proved that the
      // original append was absent.  The controller keeps that pending action
      // so a later Retry can re-run the rollback/re-apply sequence; do not
      // discard the only owner reference and strand that recovery path.
      if (ownerRef.current === owner && owner.controller.hasPendingReplayAction()) {
        owner.active = true;
        controllerRef.current = owner.controller;
        repositoryRef.current = owner.repository;
      } else if (ownerRef.current === owner) {
        ownerRef.current = null;
        controllerRef.current = null;
        repositoryRef.current = null;
      }
      if (mountedRef.current && generation === startGenerationRef.current) {
        setState('load-failed');
      }
    }
  }, [
    courseId,
    isCurrentOwner,
    lessonId,
    presentationStore,
    markReplayBoundaryFailure,
    resolveOwnedEngineControls,
    scheduleCleanup,
    startReplayEngine,
    syncControllerState,
    waitForEngineControls,
  ]);

  useEffect(() => {
    const previousEffect = lifecycleEffectRef.current;
    const token = Symbol('replay-host-effect');
    lifecycleEffectRef.current = { token, start };
    mountedRef.current = true;

    // In development React StrictMode performs a synthetic cleanup/setup pair
    // without unmounting this component instance.  The first setup may still
    // be awaiting course state or engine controls; starting a second owner in
    // that pair would strand the first replay W.  A changed `start` identity
    // is a real dependency transition and must begin a fresh lifecycle.
    if (!previousEffect || previousEffect.start !== start) {
      void start().catch((cause) => {
        log.error('[LiveCourseReplay] unhandled replay start lifecycle failure:', cause);
      });
    }

    return () => {
      mountedRef.current = false;
      // Register a placeholder cleanup synchronously so the surrounding
      // ReplayPresentationBoundary cannot dispose its adapter before this
      // Host's deferred StrictMode check has had a chance to enqueue W
      // cleanup.  The placeholder resolves to a no-op for synthetic cycles.
      const cleanupSignal = new Promise<void>((resolve) => {
        queueMicrotask(() => {
          // A subsequent setup before this microtask means either a StrictMode
          // synthetic cycle or a dependency replacement.  In both cases the
          // new setup owns the lifecycle transition and cleanup of any prior
          // owner; the old effect must not clear its refs underneath it.
          if (lifecycleEffectRef.current?.token !== token) {
            resolve();
            return;
          }
          lifecycleEffectRef.current = null;
          startGenerationRef.current += 1;
          // 中途卸载（如浏览器导航）：best-effort 销毁 replay W，不冒充成功结束。
          const owner = ownerRef.current;
          if (owner) owner.active = false;
          ownerRef.current = null;
          controllerRef.current = null;
          repositoryRef.current = null;
          let cleanup: Promise<void>;
          try {
            cleanup = owner
              ? scheduleCleanup(owner, {
                  stopEngine: true,
                  restorePresentation: false,
                })
              : Promise.resolve();
          } catch (cause) {
            log.error('[LiveCourseReplay] failed to schedule unmount cleanup:', cause);
            resolve();
            return;
          }
          void cleanup.then(resolve, (cause) => {
            log.warn('[LiveCourseReplay] best-effort replay W cleanup failed:', cause);
            resolve();
          });
        });
      });
      replayBridge.trackReplayCleanup?.(cleanupSignal);
    };
  }, [replayBridge, scheduleCleanup, start]);

  const startReplay = useCallback(async () => {
    const owner = ownerRef.current;
    if (!owner || !isCurrentOwner(owner) || owner.controller.getState() !== 'playing') {
      throw new Error('Replay is not ready to play');
    }
    const generation = owner.generation;
    const controls = await waitForEngineControls(owner, generation);
    const position = await owner.controller.getPosition();
    if (!isCurrentOwner(owner, generation)) throw new ReplayOwnerSupersededError();
    try {
      await startReplayEngine(owner, generation, controls, position ?? undefined);
    } catch (cause) {
      // The Host is the sole owner of replay-W failure state.  The engine port
      // only reports its local error; transition the controller here before
      // propagating so every caller observes the same retained position.
      if (!isCurrentOwner(owner, generation)) throw new ReplayOwnerSupersededError();
      try {
        const currentState = owner.controller.getState();
        if (currentState !== 'failed' && currentState !== 'loading' && currentState !== 'ended') {
          await owner.controller.notifyPlaybackFailure();
        }
        await syncControllerState(owner);
      } catch (failureCause) {
        log.warn('[LiveCourseReplay] failed to retain replay start failure:', failureCause);
      }
      throw cause;
    }
    if (!isCurrentOwner(owner, generation)) throw new ReplayOwnerSupersededError();
  }, [isCurrentOwner, startReplayEngine, syncControllerState, waitForEngineControls]);

  const pauseReplay = useCallback(async () => {
    const owner = ownerRef.current;
    if (!owner || !isCurrentOwner(owner)) throw new Error('Replay session is not ready');
    const generation = owner.generation;
    const controls = await waitForEngineControls(owner, generation);
    try {
      await pauseReplayPlayback(owner.controller, controls);
    } catch (cause) {
      markReplayBoundaryFailure(owner, cause);
      if (isCurrentOwner(owner, generation)) await syncControllerState(owner);
      throw cause;
    }
    if (!isCurrentOwner(owner, generation)) throw new ReplayOwnerSupersededError();
    await syncControllerState(owner);
  }, [isCurrentOwner, markReplayBoundaryFailure, syncControllerState, waitForEngineControls]);

  const resumeReplay = useCallback(async () => {
    const owner = ownerRef.current;
    if (!owner || !isCurrentOwner(owner)) throw new Error('Replay session is not ready');
    const generation = owner.generation;
    const controls = await waitForEngineControls(owner, generation);
    try {
      await resumeReplayPlayback(owner.controller, controls);
    } catch (cause) {
      markReplayBoundaryFailure(owner, cause);
      if (isCurrentOwner(owner, generation)) await syncControllerState(owner);
      throw cause;
    }
    if (!isCurrentOwner(owner, generation)) throw new ReplayOwnerSupersededError();
    await syncControllerState(owner);
  }, [isCurrentOwner, markReplayBoundaryFailure, syncControllerState, waitForEngineControls]);

  const retryReplay = useCallback(async () => {
    const owner = ownerRef.current;
    if (!owner || !isCurrentOwner(owner)) throw new Error('Replay session is not ready');
    const generation = owner.generation;
    const controls = await waitForEngineControls(owner, generation);
    try {
      await retryReplayPlayback(owner.controller, controls);
    } catch (cause) {
      markReplayBoundaryFailure(owner, cause);
      if (isCurrentOwner(owner, generation)) await syncControllerState(owner);
      throw cause;
    }
    if (!isCurrentOwner(owner, generation)) throw new ReplayOwnerSupersededError();
    await syncControllerState(owner);
  }, [isCurrentOwner, markReplayBoundaryFailure, syncControllerState, waitForEngineControls]);

  const endReplayWork = useCallback(
    async (owner: ReplayOwner): Promise<void> => {
      const previousState = owner.controller.getState();
      const wasPlaying = previousState === 'playing';
      const wasPaused = previousState === 'paused';
      let previousPosition: string | null = null;
      try {
        previousPosition = await owner.controller.getPosition();
      } catch (cause) {
        // Position is needed only to restore an engine after a failed end. Do
        // not turn a read failure into a destructive fallback; a later end
        // retry still has the authoritative controller/W to consult.
        log.warn('[LiveCourseReplay] failed to read replay position before end:', cause);
      }

      // Stop local playback before destroying W. If stop itself fails, do not
      // call controller.end(): callbacks may still append against a live W.
      const controls = resolveOwnedEngineControls(owner);
      if (controls) await controls.stop();

      try {
        await owner.controller.end();
      } catch (operationCause) {
        let restored = false;
        // Only the still-current mounted owner may restore playback.  Use the
        // Host's tokenized start path so a deferred scene mount can report a
        // later failure with a request generation; direct controls.start()
        // would leave the controller falsely `playing` when that callback
        // fails after this end operation returns.
        const controls = resolveOwnedEngineControls(owner);
        if (
          controls &&
          (wasPlaying || wasPaused) &&
          ownerRef.current === owner &&
          mountedRef.current
        ) {
          owner.active = true;
          try {
            await startReplayEngine(
              owner,
              owner.generation,
              controls,
              previousPosition ?? undefined,
              {
                paused: wasPaused,
              },
            );
            restored = true;
          } catch (restoreCause) {
            log.warn(
              '[LiveCourseReplay] failed to restore replay engine after end failure:',
              restoreCause,
            );
          }
        }

        if (
          !restored &&
          owner.controller.getState() !== 'loading' &&
          owner.controller.getState() !== 'ended'
        ) {
          try {
            await owner.controller.notifyPlaybackFailure();
          } catch (failureCause) {
            log.warn(
              '[LiveCourseReplay] failed to retain replay failure after end error:',
              failureCause,
            );
          }
        }
        throw operationCause;
      }

      // Do not restore or navigate on behalf of a replacement owner/unmounted
      // tree. Boundary disposal handles the latter after this cleanup settles.
      if (ownerRef.current === owner && mountedRef.current) {
        restorePresentation(owner.presentationStore);
      }
    },
    [resolveOwnedEngineControls, restorePresentation, startReplayEngine],
  );

  const end = useCallback(async () => {
    if (endPromiseRef.current) return endPromiseRef.current;
    const operation = (async () => {
      const owner = ownerRef.current;
      if (!owner) {
        if (mountedRef.current && !replayEndNotifiedRef.current) {
          replayEndNotifiedRef.current = true;
          restorePresentation();
          onEnd();
        }
        return;
      }
      const generation = owner.generation;
      // Claim the end operation before awaiting any engine/storage work. This
      // invalidates late playback callbacks and makes duplicate End clicks
      // converge on one cleanup promise.
      owner.active = false;
      clearDeferredPlaybackRequest(owner);
      const scheduled = cleanupBarrierRef.current.then(() => endReplayWork(owner));
      owner.cleanupPromise = scheduled;
      const settled = scheduled.then(
        () => undefined,
        (cause) => {
          log.warn('[LiveCourseReplay] replay end cleanup failed:', cause);
        },
      );
      cleanupBarrierRef.current = settled;
      replayBridge.trackReplayCleanup?.(settled);
      try {
        await scheduled;
      } catch (cause) {
        log.warn('[LiveCourseReplay] end failed:', cause);
        const canRetainForRetry =
          mountedRef.current &&
          generation === startGenerationRef.current &&
          ownerRef.current === owner;
        if (!canRetainForRetry) {
          // The component may have unmounted while controller.end() was in
          // flight.  Never resurrect an owner into a dead tree: queue a
          // best-effort cleanup for the orphaned W instead.  Clearing the
          // in-flight marker first lets cleanupReplayWork run rather than
          // merely returning the already-rejected end promise.
          owner.active = false;
          if (ownerRef.current === owner) {
            ownerRef.current = null;
            controllerRef.current = null;
            repositoryRef.current = null;
          }
          if (owner.cleanupPromise === scheduled) owner.cleanupPromise = undefined;
          queueMicrotask(() => {
            const cleanup = scheduleCleanup(owner, {
              stopEngine: true,
              restorePresentation: false,
            });
            void cleanup.catch((cleanupCause) => {
              log.warn('[LiveCourseReplay] replay end orphan cleanup failed:', cleanupCause);
            });
          });
          return;
        }
        // Keep the controller and the replay view alive so the user can retry;
        // navigating away here would hide a still-persisted replay W.
        owner.active = true;
        ownerRef.current = owner;
        controllerRef.current = owner.controller;
        repositoryRef.current = owner.repository;
        setEndFailed(true);
        return;
      } finally {
        if (owner.cleanupPromise === scheduled) owner.cleanupPromise = undefined;
      }
      if (ownerRef.current === owner) {
        ownerRef.current = null;
        controllerRef.current = null;
        repositoryRef.current = null;
      }
      if (
        !mountedRef.current ||
        generation !== startGenerationRef.current ||
        replayEndNotifiedRef.current
      ) {
        return;
      }
      replayEndNotifiedRef.current = true;
      onEnd();
    })();
    endPromiseRef.current = operation;
    try {
      await operation;
    } finally {
      if (endPromiseRef.current === operation) endPromiseRef.current = null;
    }
  }, [
    clearDeferredPlaybackRequest,
    endReplayWork,
    onEnd,
    replayBridge,
    restorePresentation,
    scheduleCleanup,
  ]);

  useEffect(() => {
    const advance = async (expectedNodeId?: string) => {
      const owner = ownerRef.current;
      if (!owner || !isCurrentOwner(owner)) return { advanced: false, ended: false };
      const generation = owner.generation;
      const result = await owner.controller.advanceResult(expectedNodeId);
      if (!isCurrentOwner(owner, generation)) throw new ReplayOwnerSupersededError();
      if (result.status === 'failed') {
        if (owner.controller.getState() !== 'failed') {
          await owner.controller.notifyPlaybackFailure();
        }
        await syncControllerState(owner);
        throw result.error instanceof Error ? result.error : new Error(String(result.error));
      }
      if (result.status === 'advanced') {
        if (isCurrentOwner(owner, generation)) setPosition(result.nodeId);
        return { advanced: true, ended: false, nodeId: result.nodeId };
      }
      return {
        advanced: false,
        ended: result.status === 'at-end',
        positionMismatch: result.status === 'position-mismatch',
      };
    };
    const navigate = async (targetNodeId: string) => {
      const owner = ownerRef.current;
      if (!owner || !isCurrentOwner(owner)) return { advanced: false, ended: false };
      const generation = owner.generation;
      const controls = await waitForEngineControls(owner, generation);
      const previousPosition = await owner.controller.getPosition();
      if (!isCurrentOwner(owner, generation)) throw new ReplayOwnerSupersededError();
      if (previousPosition === targetNodeId) return { advanced: false, ended: false };
      const wasPlaying = owner.controller.getState() === 'playing';
      const wasPaused = owner.controller.getState() === 'paused';
      let engineStopped = false;
      let targetCommitted = false;
      try {
        await controls.stop();
        engineStopped = true;
        if (!isCurrentOwner(owner, generation)) throw new ReplayOwnerSupersededError();
        const result = await owner.controller.navigate(targetNodeId);
        if (!isCurrentOwner(owner, generation)) throw new ReplayOwnerSupersededError();
        if (!result.advanced) {
          if (previousPosition && (wasPlaying || wasPaused)) {
            await startReplayEngine(owner, generation, controls, previousPosition, {
              paused: wasPaused,
            });
          }
          return result;
        }
        targetCommitted = true;
        if (isCurrentOwner(owner, generation)) setPosition(targetNodeId);
        if (wasPlaying || wasPaused) {
          try {
            await startReplayEngine(owner, generation, controls, targetNodeId, {
              paused: wasPaused,
            });
          } catch (startCause) {
            // The W cursor has already moved to the requested node. Preserve
            // that position and expose a retryable playback failure; going
            // back to the old scene would make W and the visible scene lie.
            if (owner.controller.getState() !== 'failed') {
              await owner.controller.notifyPlaybackFailure();
            }
            throw startCause;
          }
        }
        return result;
      } catch (cause) {
        if (!isCurrentOwner(owner, generation)) throw new ReplayOwnerSupersededError();
        // Keep the two state machines aligned when a navigation or target
        // engine start fails.  The controller position remains authoritative
        // and is deliberately marked failed only for a real playback error.
        if (!engineStopped) {
          try {
            if (owner.controller.getState() !== 'failed') {
              await owner.controller.notifyPlaybackFailure();
            }
            await syncControllerState(owner);
          } catch (failureCause) {
            log.warn('[LiveCourseReplay] failed to retain navigation failure:', failureCause);
          }
        } else if (
          targetCommitted ||
          cause instanceof ReplayAppendUncertaintyError ||
          cause instanceof ClassroomPresentationCommitError
        ) {
          // The target W may already be authoritative (or may be uncertain).
          // Never restore the old scene in that case; preserve the target and
          // mark the replay failed for an explicit retry.
          if (cause instanceof ClassroomPresentationCommitError) {
            owner.durablePresentation = true;
          }
          try {
            if (owner.controller.getState() !== 'failed') {
              await owner.controller.notifyPlaybackFailure();
            }
            await syncControllerState(owner);
          } catch (failureCause) {
            log.warn('[LiveCourseReplay] failed to retain target failure:', failureCause);
          }
        } else if (previousPosition && (wasPlaying || wasPaused)) {
          try {
            await startReplayEngine(owner, generation, controls, previousPosition, {
              paused: wasPaused,
            });
          } catch (restoreCause) {
            log.warn('[LiveCourseReplay] failed to restore navigation engine:', restoreCause);
            try {
              if (owner.controller.getState() !== 'failed') {
                await owner.controller.notifyPlaybackFailure();
              }
              await syncControllerState(owner);
            } catch (failureCause) {
              log.warn('[LiveCourseReplay] failed to retain navigation failure:', failureCause);
            }
          }
        }
        throw cause;
      }
    };
    const complete = () => {
      void end().catch((cause) => {
        log.error('[LiveCourseReplay] replay completion cleanup failed:', cause);
      });
    };
    replayBridge.advance = advance;
    replayBridge.navigate = navigate;
    replayBridge.complete = complete;
    replayBridge.pauseReplay = pauseReplay;
    replayBridge.resumeReplay = resumeReplay;
    replayBridge.retryReplay = retryReplay;
    replayBridge.startReplay = startReplay;
    replayBridge.reportPlaybackStarted = reportDeferredPlaybackStarted;
    replayBridge.reportPlaybackFailure = reportDeferredPlaybackFailure;
    const canNavigate = (nodeId: string) => {
      const controller = controllerRef.current;
      return Boolean(controller?.getRange().includes(nodeId));
    };
    replayBridge.canNavigate = canNavigate;
    return () => {
      if (replayBridge.advance === advance) delete replayBridge.advance;
      if (replayBridge.navigate === navigate) delete replayBridge.navigate;
      if (replayBridge.complete === complete) delete replayBridge.complete;
      if (replayBridge.pauseReplay === pauseReplay) delete replayBridge.pauseReplay;
      if (replayBridge.resumeReplay === resumeReplay) delete replayBridge.resumeReplay;
      if (replayBridge.retryReplay === retryReplay) delete replayBridge.retryReplay;
      if (replayBridge.startReplay === startReplay) delete replayBridge.startReplay;
      if (replayBridge.reportPlaybackStarted === reportDeferredPlaybackStarted) {
        delete replayBridge.reportPlaybackStarted;
      }
      if (replayBridge.reportPlaybackFailure === reportDeferredPlaybackFailure) {
        delete replayBridge.reportPlaybackFailure;
      }
      if (replayBridge.canNavigate === canNavigate) delete replayBridge.canNavigate;
    };
  }, [
    end,
    isCurrentOwner,
    pauseReplay,
    replayBridge,
    retryReplay,
    reportDeferredPlaybackFailure,
    reportDeferredPlaybackStarted,
    resumeReplay,
    startReplay,
    startReplayEngine,
    syncControllerState,
    waitForEngineControls,
  ]);

  const lessonPlan = (() => {
    const activeStage = useStageStore.getState();
    return activeStage.stage
      ? resolveLessonPlan({
          stage: activeStage.stage,
          scenes: activeStage.scenes,
          persistedLessonPlan: activeStage.lessonPlan,
          courseId,
        })
      : null;
  })();
  const positionTitle = position
    ? (lessonPlan?.nodes.find((node) => node.id === position)?.title ?? position)
    : null;
  const positionIndex = position ? range.indexOf(position) : -1;

  const barClass =
    'lc-control-strip relative z-20 flex shrink-0 flex-wrap items-center gap-3 px-4 py-3 text-sm';

  if (state === 'boot' || state === 'loading') {
    return (
      <div data-testid="classroom-replay-bar" className={barClass}>
        <GameLoader size="sm" label={t('livecourse.replayLoading')} />
      </div>
    );
  }

  if (state === 'load-failed') {
    // J4.2/J4.4：加载失败留在发起入口的选择态，可重试或返回。
    return (
      <div data-testid="classroom-replay-bar" className={barClass}>
        <span role="alert" className="text-destructive">
          {t('livecourse.replayLoadFailed')}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void start().catch((cause) =>
              log.error('[LiveCourseReplay] replay retry start failed:', cause),
            )
          }
        >
          {t('livecourse.retry')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onAbort}>
          {t('livecourse.replayBack')}
        </Button>
      </div>
    );
  }

  return (
    <div data-testid="classroom-replay-bar" className={barClass}>
      <span className="min-w-0 basis-full break-words text-muted-foreground sm:flex-1 sm:basis-0">
        {positionTitle
          ? t('livecourse.replayPosition', {
              title: positionTitle,
              index: positionIndex + 1,
              total: range.length,
            })
          : t('livecourse.replayLoading')}
      </span>
      {state === 'failed' && (
        <span role="alert" className="text-destructive">
          {t('livecourse.replayFailed')}
        </span>
      )}
      {endFailed && state !== 'failed' && (
        <span role="alert" className="text-destructive">
          {t('livecourse.replayFailed')}
        </span>
      )}
      {state === 'playing' && (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void pauseReplay().catch((cause) => log.warn('[LiveCourseReplay] pause failed:', cause))
          }
        >
          {t('livecourse.pause')}
        </Button>
      )}
      {state === 'paused' && (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void resumeReplay().catch((cause) =>
              log.warn('[LiveCourseReplay] resume failed:', cause),
            )
          }
        >
          {t('livecourse.resume')}
        </Button>
      )}
      {state === 'failed' && (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void retryReplay().catch((cause) => log.warn('[LiveCourseReplay] retry failed:', cause))
          }
        >
          {t('livecourse.retry')}
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          void end().catch((cause) => log.error('[LiveCourseReplay] replay end failed:', cause))
        }
      >
        {t('livecourse.endReplay')}
      </Button>
    </div>
  );
}
