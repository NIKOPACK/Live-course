import { describe, expect, it, vi } from 'vitest';

import {
  pauseReplayPlayback,
  resumeReplayPlayback,
  retryReplayPlayback,
  runReplayPlaybackTransaction,
} from '@/lib/livecourse/session/replay-playback-control';

describe('runReplayPlaybackTransaction', () => {
  it('runs the first step before the commit step and does not roll back on success', async () => {
    const calls: string[] = [];

    await runReplayPlaybackTransaction({
      first: () => calls.push('first'),
      commit: () => calls.push('commit'),
      rollback: () => calls.push('rollback'),
    });

    expect(calls).toEqual(['first', 'commit']);
  });

  it('rolls back the first step when the commit fails and preserves the commit error', async () => {
    const calls: string[] = [];
    const commitError = new Error('replay W write failed');

    await expect(
      runReplayPlaybackTransaction({
        first: () => calls.push('first'),
        commit: () => {
          calls.push('commit');
          throw commitError;
        },
        rollback: () => calls.push('rollback'),
      }),
    ).rejects.toBe(commitError);

    expect(calls).toEqual(['first', 'commit', 'rollback']);
  });

  it('surfaces both errors when rollback itself fails', async () => {
    const commitError = new Error('replay W write failed');
    const rollbackError = new Error('engine restore failed');

    await expect(
      runReplayPlaybackTransaction({
        first: vi.fn(),
        commit: () => Promise.reject(commitError),
        rollback: () => Promise.reject(rollbackError),
      }),
    ).rejects.toMatchObject({
      name: 'ReplayPlaybackControlError',
      operationCause: commitError,
      rollbackCause: rollbackError,
    });
  });
});

describe('replay playback coordination', () => {
  it('pauses the engine before W and restores the engine when the W write fails', async () => {
    const calls: string[] = [];
    const writeError = new Error('pause W write failed');
    let engineState: 'playing' | 'paused' = 'playing';
    const controllerState: 'playing' | 'paused' = 'playing';

    await expect(
      pauseReplayPlayback(
        {
          pause: async () => {
            calls.push('controller.pause');
            throw writeError;
          },
        },
        {
          pause: () => {
            calls.push('engine.pause');
            engineState = 'paused';
          },
          resume: () => {
            calls.push('engine.resume');
            engineState = 'playing';
          },
        },
      ),
    ).rejects.toBe(writeError);

    expect(calls).toEqual(['engine.pause', 'controller.pause', 'engine.resume']);
    expect(engineState).toBe('playing');
    expect(controllerState).toBe('playing');
  });

  it('commits resume to W before resuming the engine', async () => {
    const calls: string[] = [];
    let engineState: 'playing' | 'paused' = 'paused';
    let controllerState: 'playing' | 'paused' = 'paused';

    await resumeReplayPlayback(
      {
        pause: async () => {
          calls.push('controller.pause');
          controllerState = 'paused';
          return controllerState;
        },
        resume: async () => {
          calls.push('controller.resume');
          controllerState = 'playing';
          return controllerState;
        },
      },
      {
        pause: vi.fn(),
        resume: () => {
          calls.push('engine.resume');
          expect(controllerState).toBe('playing');
          engineState = 'playing';
        },
      },
    );

    expect(calls).toEqual(['controller.resume', 'engine.resume']);
    expect(engineState).toBe('playing');
    expect(controllerState).toBe('playing');
  });

  it('restarts an idle engine after controller retry and returns both sides to failed on error', async () => {
    const calls: string[] = [];
    let engineState: 'idle' | 'playing' = 'idle';
    let controllerState: 'failed' | 'playing' = 'failed';
    let failEngineRetry = false;
    const controller = {
      pause: vi.fn(),
      resume: vi.fn(),
      retry: async () => {
        calls.push('controller.retry');
        controllerState = 'playing';
        return controllerState;
      },
      notifyPlaybackFailure: async () => {
        calls.push('controller.fail');
        controllerState = 'failed';
        return controllerState;
      },
    };
    const playback = {
      pause: vi.fn(),
      resume: vi.fn(),
      retry: () => {
        calls.push('engine.retry');
        expect(controllerState).toBe('playing');
        if (failEngineRetry) throw new Error('engine restart failed');
        engineState = 'playing';
      },
    };

    await retryReplayPlayback(controller, playback);

    expect(calls).toEqual(['controller.retry', 'engine.retry']);
    expect(engineState).toBe('playing');
    expect(controllerState).toBe('playing');

    calls.length = 0;
    engineState = 'idle';
    controllerState = 'failed';
    failEngineRetry = true;
    await expect(retryReplayPlayback(controller, playback)).rejects.toThrow(
      'engine restart failed',
    );

    expect(calls).toEqual(['controller.retry', 'engine.retry', 'controller.fail']);
    expect(engineState).toBe('idle');
    expect(controllerState).toBe('failed');
  });
});
