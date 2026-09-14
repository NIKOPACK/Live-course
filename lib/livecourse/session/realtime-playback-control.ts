import type {
  TeachingPlaybackControlPort,
  TeachingPlaybackStep,
} from './teaching-playback-control';
import {
  applyPlaybackStepWithRollback,
  collectPlaybackRollbackCauses,
} from './teaching-playback-control';

export interface RealtimePlaybackControlPort extends TeachingPlaybackControlPort {
  assertFrozen: TeachingPlaybackStep;
  assertReleased: TeachingPlaybackStep;
}

export class RealtimePlaybackControlError extends Error {
  override readonly name = 'RealtimePlaybackControlError';
  readonly operationCause: unknown;
  readonly rollbackCauses: readonly unknown[];

  constructor(operationCause: unknown, rollbackCauses: readonly unknown[]) {
    super('Realtime playback state could not be restored after a failed transition');
    this.operationCause = operationCause;
    this.rollbackCauses = rollbackCauses;
  }
}

/**
 * Keep the UI's held-node marker aligned with the outcome of a freeze.
 *
 * An ordinary failure is surfaced only after every known inverse succeeded, so
 * the local narrator is already playing and must not receive a second release
 * attempt.  A `RealtimePlaybackControlError` explicitly means at least one
 * inverse failed after a partial mutation; retaining the node lets the caller
 * retry the release boundary (including during close) instead of losing the
 * only recovery handle.
 */
export function retainRealtimePlaybackHoldAfterFreezeFailure(
  currentNodeId: string | null,
  nodeId: string,
  cause: unknown,
): string | null {
  if (cause instanceof RealtimePlaybackControlError) {
    // A different unresolved hold owns the release boundary already; never
    // overwrite its recovery handle with a second node.
    return currentNodeId === null || currentNodeId === nodeId ? nodeId : currentNodeId;
  }
  return currentNodeId === nodeId ? null : currentNodeId;
}

async function restoreAfterFailure(
  operationCause: unknown,
  rollbackSteps: readonly TeachingPlaybackStep[],
): Promise<never> {
  const rollbackCauses = await collectPlaybackRollbackCauses(rollbackSteps);
  if (rollbackCauses.length > 0) {
    throw new RealtimePlaybackControlError(operationCause, rollbackCauses);
  }
  throw operationCause;
}

/** Freeze the narrator and its text buffer before W records an interruption. */
export async function freezeRealtimePlayback(playback: RealtimePlaybackControlPort): Promise<void> {
  // Register the inverse before invoking each operation. A playback adapter
  // can mutate its state and then throw; waiting until the promise resolves to
  // record success would leave that partial mutation unreconciled.
  const rollbackSteps: TeachingPlaybackStep[] = [];
  try {
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
    await playback.assertFrozen();
  } catch (cause) {
    await restoreAfterFailure(cause, rollbackSteps);
  }
}

/** Release a frozen narrator after W records lesson.resume_interrupted. */
export async function releaseRealtimePlayback(
  playback: RealtimePlaybackControlPort,
): Promise<void> {
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
    await playback.assertReleased();
  } catch (cause) {
    await restoreAfterFailure(cause, rollbackSteps);
  }
}
