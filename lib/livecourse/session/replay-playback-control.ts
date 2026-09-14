/**
 * Small transaction seam for replay controls.
 *
 * A replay pause/resume has two observable sides: the local PlaybackEngine
 * and the replay working-memory (`W`) command.  The engine must be moved first
 * so no more audio/actions can run while the W command is being persisted.  If
 * that command fails, the engine is restored to its previous state.  Keeping
 * this ordering in a framework-independent helper makes the invariant easy to
 * test without mounting the full classroom tree.
 */

// A control callback may return a meaningful state value (for example the
// controller's `pause()` returns its new state).  The transaction only needs
// to await completion, so retain that value as `unknown` instead of forcing
// every caller to add a pointless `then(() => undefined)` wrapper.
export type ReplayPlaybackStep = () => unknown | Promise<unknown>;

/** The controller side of the replay state transition. */
export interface ReplayControllerControlPort {
  pause: () => Promise<unknown>;
  resume: () => Promise<unknown>;
  retry: () => Promise<unknown>;
  notifyPlaybackFailure: () => Promise<unknown>;
}

/** The local PlaybackEngine side of the replay state transition. */
export interface ReplayPlaybackControlPort {
  pause: ReplayPlaybackStep;
  resume: ReplayPlaybackStep;
  retry: ReplayPlaybackStep;
}

export interface ReplayPlaybackTransaction<T> {
  /** Apply the first side of the transition. */
  first: ReplayPlaybackStep;
  /** Apply the second side of the transition. */
  commit: () => T | Promise<T>;
  /** Compensate the first side when the second side cannot be applied. */
  rollback: ReplayPlaybackStep;
}

/**
 * Raised only when both the replay W command and the local engine rollback
 * fail.  Exposing both causes avoids hiding the original persistence error or
 * pretending that the two state machines are still aligned.
 */
export class ReplayPlaybackControlError extends Error {
  override readonly name = 'ReplayPlaybackControlError';
  readonly operationCause: unknown;
  readonly rollbackCause: unknown;

  constructor(operationCause: unknown, rollbackCause: unknown) {
    super('Replay playback state could not be restored after a failed command');
    this.operationCause = operationCause;
    this.rollbackCause = rollbackCause;
  }
}

export async function runReplayPlaybackTransaction<T>({
  first,
  commit,
  rollback,
}: ReplayPlaybackTransaction<T>): Promise<T> {
  await first();
  try {
    return await commit();
  } catch (operationCause) {
    try {
      await rollback();
    } catch (rollbackCause) {
      throw new ReplayPlaybackControlError(operationCause, rollbackCause);
    }
    throw operationCause;
  }
}

/**
 * Pause is ordered engine → replay W.  This freezes local work before the
 * asynchronous W append; a failed append can therefore restore the engine
 * without writing a compensating W action.
 */
export function pauseReplayPlayback(
  controller: Pick<ReplayControllerControlPort, 'pause'>,
  playback: Pick<ReplayPlaybackControlPort, 'pause' | 'resume'>,
): Promise<unknown> {
  return runReplayPlaybackTransaction({
    first: playback.pause,
    commit: controller.pause,
    rollback: playback.resume,
  });
}

/**
 * Resume is ordered replay W → engine.  The controller must be playing before
 * the engine is released, otherwise an immediate natural completion could
 * attempt `advance()` while the controller still rejects playing commands.
 */
export function resumeReplayPlayback(
  controller: Pick<ReplayControllerControlPort, 'resume' | 'pause'>,
  playback: Pick<ReplayPlaybackControlPort, 'resume' | 'pause'>,
): Promise<unknown> {
  return runReplayPlaybackTransaction({
    first: controller.resume,
    commit: playback.resume,
    rollback: controller.pause,
  });
}

/**
 * Retry is ordered replay W → engine.  A failed replay normally leaves the
 * engine idle; the local retry operation must explicitly start that node
 * again.  If starting fails, `notifyPlaybackFailure` restores the controller
 * state without appending another navigation command.
 */
export function retryReplayPlayback(
  controller: Pick<ReplayControllerControlPort, 'retry' | 'notifyPlaybackFailure'>,
  playback: Pick<ReplayPlaybackControlPort, 'retry'>,
): Promise<unknown> {
  return runReplayPlaybackTransaction({
    first: controller.retry,
    commit: playback.retry,
    rollback: controller.notifyPlaybackFailure,
  });
}
