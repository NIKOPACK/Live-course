/**
 * Transaction seams for the teaching classroom controls.
 *
 * A pause/continue command has two observable sides: the local playback
 * engine (and its lecture buffer) and the authoritative classroom W command.
 * The order is deliberately different in each direction:
 *
 *   pause  local engine/buffer -> W
 *   resume W -> local engine/buffer
 *
 * If either side fails, the first side is compensated so the state exposed to
 * the learner remains the state that is actually playing on screen.
 */

import { readClassroomActionAuthority } from './controller';

export type TeachingPlaybackStep = () => unknown | Promise<unknown>;

/**
 * A boundary probe for a local playback side. `null` means that side does not
 * currently exist (for example a lecture buffer has already been disposed),
 * while `undefined` means that the caller cannot determine the state.
 */
export type PlaybackStateProbe = () => boolean | null | undefined;

export interface TeachingControllerControlPort {
  pause: () => Promise<unknown>;
  resume: () => Promise<unknown>;
}

export interface TeachingPlaybackControlPort {
  pauseEngine: TeachingPlaybackStep;
  resumeEngine: TeachingPlaybackStep;
  pauseBuffer: TeachingPlaybackStep;
  resumeBuffer: TeachingPlaybackStep;
  /** Optional probes let a failed operation distinguish no-op from partial mutation. */
  isEnginePaused?: PlaybackStateProbe;
  isBufferPaused?: PlaybackStateProbe;
}

export interface PauseTeachingPlaybackOptions {
  /**
   * Some controller failures mean the W append may already be durable. In
   * that case releasing the locally frozen playback would create a visible
   * split-brain state, so the caller can keep it paused while reconciling the
   * same command key.
   */
  shouldRollbackAfterCommitFailure?: (cause: unknown) => boolean;
}

export class TeachingPlaybackControlError extends Error {
  override readonly name = 'TeachingPlaybackControlError';
  readonly operationCause: unknown;
  readonly rollbackCause: unknown;
  readonly rollbackCauses: readonly unknown[];
  /** Propagates an authority marker carried by a failed W compensation. */
  readonly authority?: 'committed' | 'uncertain' | 'not_committed';

  constructor(
    operationCause: unknown,
    rollbackCause: unknown,
    rollbackCauses: readonly unknown[] = [rollbackCause],
  ) {
    super('Teaching playback state could not be restored after a failed command');
    this.operationCause = operationCause;
    this.rollbackCause = rollbackCause;
    this.rollbackCauses = rollbackCauses;
    // Preserve the strongest authority carried by any nested W compensation
    // failure. This uses the same traversal as the classroom UI so a wrapped
    // AggregateError cannot downgrade an unresolved/committed outcome.
    this.authority = readClassroomActionAuthority({ errors: rollbackCauses }) ?? undefined;
  }
}

export async function collectPlaybackRollbackCauses(
  rollbackSteps: readonly TeachingPlaybackStep[],
): Promise<unknown[]> {
  const rollbackCauses: unknown[] = [];
  // Run every inverse operation even when one fails. A partially restored
  // engine must not prevent the buffer (or vice versa) from being repaired.
  for (let index = rollbackSteps.length - 1; index >= 0; index -= 1) {
    try {
      await rollbackSteps[index]!();
    } catch (cause) {
      rollbackCauses.push(cause);
    }
  }
  return rollbackCauses;
}

function readPlaybackState(probe: PlaybackStateProbe | undefined): boolean | null | undefined {
  if (!probe) return undefined;
  try {
    return probe();
  } catch {
    // A failed probe leaves the transition uncertain; callers compensate and
    // surface any resulting inverse failure rather than hiding it.
    return undefined;
  }
}

/**
 * Apply one local transition and register its inverse. If the operation
 * throws, the inverse is registered only when the probe proves that state
 * changed; without a reliable probe we conservatively treat the state as
 * uncertain and register it anyway.
 */
export async function applyPlaybackStepWithRollback(input: {
  operation: TeachingPlaybackStep;
  rollback: TeachingPlaybackStep;
  probe?: PlaybackStateProbe;
  rollbackSteps: TeachingPlaybackStep[];
}): Promise<void> {
  const before = readPlaybackState(input.probe);
  try {
    await input.operation();
    input.rollbackSteps.push(input.rollback);
  } catch (cause) {
    const after = readPlaybackState(input.probe);
    if (before === undefined || after === undefined || before !== after) {
      input.rollbackSteps.push(input.rollback);
    }
    throw cause;
  }
}

async function restoreAfterFailure(
  operationCause: unknown,
  rollbackSteps: readonly TeachingPlaybackStep[],
): Promise<never> {
  const rollbackCauses = await collectPlaybackRollbackCauses(rollbackSteps);
  if (rollbackCauses.length > 0) {
    throw new TeachingPlaybackControlError(operationCause, rollbackCauses[0], rollbackCauses);
  }
  throw operationCause;
}

/**
 * Freeze local playback before appending the pause command to W.  Buffer
 * pausing is part of the same local step; if it fails, the engine is resumed
 * before the error reaches the caller and no W command is attempted.
 */
export async function pauseTeachingPlayback(
  controller: Pick<TeachingControllerControlPort, 'pause'>,
  playback: TeachingPlaybackControlPort,
  options: PauseTeachingPlaybackOptions = {},
): Promise<unknown> {
  const rollbackSteps: TeachingPlaybackStep[] = [];
  try {
    // Register inverses before calling the operation: adapters can mutate and
    // then throw, so a successful return value is not the only evidence that
    // a state transition may have occurred.
    await applyPlaybackStepWithRollback({
      operation: playback.pauseEngine,
      rollback: playback.resumeEngine,
      probe: playback.isEnginePaused,
      rollbackSteps,
    });
    await applyPlaybackStepWithRollback({
      operation: playback.pauseBuffer,
      rollback: playback.resumeBuffer,
      probe: playback.isBufferPaused,
      rollbackSteps,
    });
  } catch (cause) {
    return restoreAfterFailure(cause, rollbackSteps);
  }

  try {
    return await controller.pause();
  } catch (cause) {
    if (options.shouldRollbackAfterCommitFailure?.(cause) === false) throw cause;
    return restoreAfterFailure(cause, rollbackSteps);
  }
}

/**
 * Commit the W resume first.  If releasing the engine or lecture buffer fails,
 * pause the local side again before compensating W back to paused.
 */
export function resumeTeachingPlayback(
  controller: Pick<TeachingControllerControlPort, 'resume' | 'pause'>,
  playback: TeachingPlaybackControlPort,
): Promise<unknown> {
  return (async () => {
    // W must move first. If this call reports an authority-bearing failure,
    // leave the local side untouched so the caller can reconcile that exact
    // idempotency key rather than issuing an unsafe compensation.
    await controller.resume();

    const rollbackSteps: TeachingPlaybackStep[] = [];
    try {
      await applyPlaybackStepWithRollback({
        operation: playback.resumeEngine,
        rollback: playback.pauseEngine,
        probe: playback.isEnginePaused,
        rollbackSteps,
      });
      await applyPlaybackStepWithRollback({
        operation: playback.resumeBuffer,
        rollback: playback.pauseBuffer,
        probe: playback.isBufferPaused,
        rollbackSteps,
      });
    } catch (operationCause) {
      const rollbackCauses = await collectPlaybackRollbackCauses(rollbackSteps);
      try {
        await controller.pause();
      } catch (cause) {
        rollbackCauses.push(cause);
      }
      if (rollbackCauses.length > 0) {
        throw new TeachingPlaybackControlError(operationCause, rollbackCauses[0], rollbackCauses);
      }
      throw operationCause;
    }
  })();
}
