import { describe, expect, it } from 'vitest';

import {
  freezeRealtimePlayback,
  releaseRealtimePlayback,
  RealtimePlaybackControlError,
  retainRealtimePlaybackHoldAfterFreezeFailure,
} from '@/lib/livecourse/session/realtime-playback-control';

describe('realtime playback coordination', () => {
  it('retains a held node only when a freeze rollback remains uncertain', () => {
    const ordinaryFailure = new Error('freeze failed after a complete rollback');
    const partialFailure = new RealtimePlaybackControlError(
      new Error('freeze failed after mutation'),
      [new Error('rollback failed')],
    );

    expect(
      retainRealtimePlaybackHoldAfterFreezeFailure(null, 'node-1', ordinaryFailure),
    ).toBeNull();
    expect(retainRealtimePlaybackHoldAfterFreezeFailure(null, 'node-1', partialFailure)).toBe(
      'node-1',
    );
    // Never discard an unrelated unresolved hold while another node reports a
    // fully rolled-back failure.
    expect(retainRealtimePlaybackHoldAfterFreezeFailure('node-0', 'node-1', ordinaryFailure)).toBe(
      'node-0',
    );
    expect(retainRealtimePlaybackHoldAfterFreezeFailure('node-0', 'node-1', partialFailure)).toBe(
      'node-0',
    );
  });

  it('freezes the engine before its lecture buffer', async () => {
    const calls: string[] = [];

    await freezeRealtimePlayback({
      pauseEngine: () => calls.push('engine.pause'),
      pauseBuffer: () => calls.push('buffer.pause'),
      resumeEngine: () => calls.push('engine.resume'),
      resumeBuffer: () => calls.push('buffer.resume'),
      assertFrozen: () => undefined,
      assertReleased: () => undefined,
    });

    expect(calls).toEqual(['engine.pause', 'buffer.pause']);
  });

  it('restores both local sides when buffer freeze fails', async () => {
    const calls: string[] = [];
    const bufferError = new Error('buffer pause failed');

    await expect(
      freezeRealtimePlayback({
        pauseEngine: () => calls.push('engine.pause'),
        pauseBuffer: () => {
          calls.push('buffer.pause');
          throw bufferError;
        },
        resumeBuffer: () => calls.push('buffer.resume'),
        resumeEngine: () => calls.push('engine.resume'),
        assertFrozen: () => undefined,
        assertReleased: () => undefined,
      }),
    ).rejects.toBe(bufferError);

    expect(calls).toEqual(['engine.pause', 'buffer.pause', 'buffer.resume', 'engine.resume']);
  });

  it('restores the engine when the first freeze step mutates then throws', async () => {
    const calls: string[] = [];
    const pauseError = new Error('engine pause failed after mutation');
    let engine: 'playing' | 'paused' = 'playing';

    await expect(
      freezeRealtimePlayback({
        pauseEngine: () => {
          calls.push('engine.pause');
          engine = 'paused';
          throw pauseError;
        },
        pauseBuffer: () => calls.push('buffer.pause'),
        resumeBuffer: () => calls.push('buffer.resume'),
        resumeEngine: () => {
          calls.push('engine.resume');
          engine = 'playing';
        },
        assertFrozen: () => undefined,
        assertReleased: () => undefined,
      }),
    ).rejects.toBe(pauseError);

    expect(calls).toEqual(['engine.pause', 'engine.resume']);
    expect(engine).toBe('playing');
  });

  it('releases the engine before its lecture buffer', async () => {
    const calls: string[] = [];

    await releaseRealtimePlayback({
      pauseEngine: () => calls.push('engine.pause'),
      pauseBuffer: () => calls.push('buffer.pause'),
      resumeEngine: () => calls.push('engine.resume'),
      resumeBuffer: () => calls.push('buffer.resume'),
      assertFrozen: () => undefined,
      assertReleased: () => undefined,
    });

    expect(calls).toEqual(['engine.resume', 'buffer.resume']);
  });

  it('pauses both local sides again when buffer release fails', async () => {
    const calls: string[] = [];
    const bufferError = new Error('buffer resume failed');

    await expect(
      releaseRealtimePlayback({
        resumeEngine: () => calls.push('engine.resume'),
        resumeBuffer: () => {
          calls.push('buffer.resume');
          throw bufferError;
        },
        pauseBuffer: () => calls.push('buffer.pause'),
        pauseEngine: () => calls.push('engine.pause'),
        assertFrozen: () => undefined,
        assertReleased: () => undefined,
      }),
    ).rejects.toBe(bufferError);

    expect(calls).toEqual(['engine.resume', 'buffer.resume', 'buffer.pause', 'engine.pause']);
  });

  it('restores the engine when the first release step mutates then throws', async () => {
    const calls: string[] = [];
    const resumeError = new Error('engine resume failed after mutation');
    let engine: 'playing' | 'paused' = 'paused';

    await expect(
      releaseRealtimePlayback({
        resumeEngine: () => {
          calls.push('engine.resume');
          engine = 'playing';
          throw resumeError;
        },
        resumeBuffer: () => calls.push('buffer.resume'),
        pauseBuffer: () => calls.push('buffer.pause'),
        pauseEngine: () => {
          calls.push('engine.pause');
          engine = 'paused';
        },
        assertFrozen: () => undefined,
        assertReleased: () => undefined,
      }),
    ).rejects.toBe(resumeError);

    expect(calls).toEqual(['engine.resume', 'engine.pause']);
    expect(engine).toBe('paused');
  });

  it('surfaces the operation and every rollback failure', async () => {
    const operationCause = new Error('buffer resume failed');
    const bufferRollback = new Error('buffer pause failed');
    const engineRollback = new Error('engine pause failed');

    await expect(
      releaseRealtimePlayback({
        resumeEngine: () => undefined,
        resumeBuffer: () => {
          throw operationCause;
        },
        pauseBuffer: () => {
          throw bufferRollback;
        },
        pauseEngine: () => {
          throw engineRollback;
        },
        assertFrozen: () => undefined,
        assertReleased: () => undefined,
      }),
    ).rejects.toMatchObject({
      name: 'RealtimePlaybackControlError',
      operationCause,
      rollbackCauses: [bufferRollback, engineRollback],
    } satisfies Partial<RealtimePlaybackControlError>);
  });

  it('rolls playback back when the installed engine changes mid-transition', async () => {
    const calls: string[] = [];
    const identityError = new Error('engine changed');

    await expect(
      freezeRealtimePlayback({
        pauseEngine: () => calls.push('engine.pause'),
        pauseBuffer: () => calls.push('buffer.pause'),
        resumeBuffer: () => calls.push('buffer.resume'),
        resumeEngine: () => calls.push('engine.resume'),
        assertFrozen: () => {
          calls.push('assert.frozen');
          throw identityError;
        },
        assertReleased: () => undefined,
      }),
    ).rejects.toBe(identityError);

    expect(calls).toEqual([
      'engine.pause',
      'buffer.pause',
      'assert.frozen',
      'buffer.resume',
      'engine.resume',
    ]);
  });
});
