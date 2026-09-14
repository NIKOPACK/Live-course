import { describe, expect, it, vi } from 'vitest';

import {
  pauseTeachingPlayback,
  resumeTeachingPlayback,
  TeachingPlaybackControlError,
} from '@/lib/livecourse/session/teaching-playback-control';

describe('teaching playback coordination', () => {
  it('pauses engine and buffer before W, then restores both when W fails', async () => {
    const calls: string[] = [];
    const writeError = new Error('pause W failed');
    let engine: 'playing' | 'paused' = 'playing';
    let buffer: 'playing' | 'paused' = 'playing';

    await expect(
      pauseTeachingPlayback(
        {
          pause: async () => {
            calls.push('W.pause');
            throw writeError;
          },
        },
        {
          pauseEngine: () => {
            calls.push('engine.pause');
            engine = 'paused';
          },
          resumeEngine: () => {
            calls.push('engine.resume');
            engine = 'playing';
          },
          pauseBuffer: () => {
            calls.push('buffer.pause');
            buffer = 'paused';
          },
          resumeBuffer: () => {
            calls.push('buffer.resume');
            buffer = 'playing';
          },
          isBufferPaused: () => buffer === 'paused',
        },
      ),
    ).rejects.toBe(writeError);

    expect(calls).toEqual([
      'engine.pause',
      'buffer.pause',
      'W.pause',
      'buffer.resume',
      'engine.resume',
    ]);
    expect(engine).toBe('playing');
    expect(buffer).toBe('playing');
  });

  it('does not write W when the local buffer cannot be paused', async () => {
    const calls: string[] = [];
    const bufferError = new Error('buffer failed');
    const pause = vi.fn(async () => calls.push('W.pause'));
    let buffer: 'playing' | 'paused' = 'playing';

    await expect(
      pauseTeachingPlayback(
        { pause },
        {
          pauseEngine: () => calls.push('engine.pause'),
          resumeEngine: () => calls.push('engine.resume'),
          pauseBuffer: () => {
            calls.push('buffer.pause');
            throw bufferError;
          },
          resumeBuffer: () => {
            calls.push('buffer.resume');
            buffer = 'playing';
          },
          isBufferPaused: () => buffer === 'paused',
        },
      ),
    ).rejects.toBe(bufferError);

    expect(calls).toEqual(['engine.pause', 'buffer.pause', 'engine.resume']);
    expect(pause).not.toHaveBeenCalled();
  });

  it('restores the engine when its pause step mutates then throws', async () => {
    const calls: string[] = [];
    const pauseError = new Error('engine pause failed after mutation');
    let engine: 'playing' | 'paused' = 'playing';
    const pause = vi.fn(async () => calls.push('W.pause'));

    await expect(
      pauseTeachingPlayback(
        { pause },
        {
          pauseEngine: () => {
            calls.push('engine.pause');
            engine = 'paused';
            throw pauseError;
          },
          resumeEngine: () => {
            calls.push('engine.resume');
            engine = 'playing';
          },
          isEnginePaused: () => engine === 'paused',
          pauseBuffer: () => calls.push('buffer.pause'),
          resumeBuffer: () => calls.push('buffer.resume'),
        },
      ),
    ).rejects.toBe(pauseError);

    expect(calls).toEqual(['engine.pause', 'engine.resume']);
    expect(engine).toBe('playing');
    expect(pause).not.toHaveBeenCalled();
  });

  it('restores the buffer and engine when buffer pause mutates then throws', async () => {
    const calls: string[] = [];
    const pauseError = new Error('buffer pause failed after mutation');
    let engine: 'playing' | 'paused' = 'playing';
    let buffer: 'playing' | 'paused' = 'playing';

    await expect(
      pauseTeachingPlayback(
        { pause: vi.fn() },
        {
          pauseEngine: () => {
            calls.push('engine.pause');
            engine = 'paused';
          },
          resumeEngine: () => {
            calls.push('engine.resume');
            engine = 'playing';
          },
          isEnginePaused: () => engine === 'paused',
          pauseBuffer: () => {
            calls.push('buffer.pause');
            buffer = 'paused';
            throw pauseError;
          },
          resumeBuffer: () => {
            calls.push('buffer.resume');
            buffer = 'playing';
          },
        },
      ),
    ).rejects.toBe(pauseError);

    expect(calls).toEqual(['engine.pause', 'buffer.pause', 'buffer.resume', 'engine.resume']);
    expect(engine).toBe('playing');
    expect(buffer).toBe('playing');
  });

  it('keeps local playback frozen when the W outcome is not safe to roll back', async () => {
    const calls: string[] = [];
    const uncertainWrite = new Error('pause append outcome is uncertain');

    await expect(
      pauseTeachingPlayback(
        {
          pause: async () => {
            calls.push('W.pause');
            throw uncertainWrite;
          },
        },
        {
          pauseEngine: () => calls.push('engine.pause'),
          resumeEngine: () => calls.push('engine.resume'),
          pauseBuffer: () => calls.push('buffer.pause'),
          resumeBuffer: () => calls.push('buffer.resume'),
        },
        { shouldRollbackAfterCommitFailure: (cause) => cause !== uncertainWrite },
      ),
    ).rejects.toBe(uncertainWrite);

    expect(calls).toEqual(['engine.pause', 'buffer.pause', 'W.pause']);
  });

  it('preserves both causes when a local pause cannot be rolled back', async () => {
    const bufferError = new Error('buffer pause failed');
    const rollbackError = new Error('engine resume failed');

    await expect(
      pauseTeachingPlayback(
        { pause: vi.fn() },
        {
          pauseEngine: () => undefined,
          resumeEngine: () => {
            throw rollbackError;
          },
          pauseBuffer: () => {
            throw bufferError;
          },
          resumeBuffer: () => undefined,
        },
      ),
    ).rejects.toMatchObject({
      name: 'TeachingPlaybackControlError',
      operationCause: bufferError,
      rollbackCause: rollbackError,
    } satisfies Partial<TeachingPlaybackControlError>);
  });

  it('writes W before releasing the engine and buffer', async () => {
    const calls: string[] = [];
    let controllerState: 'paused' | 'playing' = 'paused';

    await resumeTeachingPlayback(
      {
        resume: async () => {
          calls.push('W.resume');
          controllerState = 'playing';
        },
        pause: async () => {
          calls.push('W.pause');
          controllerState = 'paused';
        },
      },
      {
        pauseEngine: () => calls.push('engine.pause'),
        resumeEngine: () => {
          calls.push('engine.resume');
          expect(controllerState).toBe('playing');
        },
        pauseBuffer: () => calls.push('buffer.pause'),
        resumeBuffer: () => calls.push('buffer.resume'),
      },
    );

    expect(calls).toEqual(['W.resume', 'engine.resume', 'buffer.resume']);
  });

  it('compensates W when releasing the local side fails', async () => {
    const calls: string[] = [];
    const engineError = new Error('engine resume failed');
    let state: 'paused' | 'playing' = 'paused';

    await expect(
      resumeTeachingPlayback(
        {
          resume: async () => {
            calls.push('W.resume');
            state = 'playing';
          },
          pause: async () => {
            calls.push('W.pause');
            state = 'paused';
          },
        },
        {
          pauseEngine: () => calls.push('engine.pause'),
          resumeEngine: () => {
            calls.push('engine.resume');
            throw engineError;
          },
          isEnginePaused: () => state === 'paused',
          pauseBuffer: () => calls.push('buffer.pause'),
          resumeBuffer: () => calls.push('buffer.resume'),
        },
      ),
    ).rejects.toBe(engineError);

    expect(calls).toEqual(['W.resume', 'engine.resume', 'W.pause']);
    expect(state).toBe('paused');
  });

  it('compensates local engine and W when engine resume mutates then throws', async () => {
    const calls: string[] = [];
    const engineError = new Error('engine resume failed after mutation');
    let state: 'paused' | 'playing' = 'paused';
    let engineState: 'paused' | 'playing' = 'paused';

    await expect(
      resumeTeachingPlayback(
        {
          resume: async () => {
            calls.push('W.resume');
            state = 'playing';
          },
          pause: async () => {
            calls.push('W.pause');
            state = 'paused';
          },
        },
        {
          pauseEngine: () => {
            calls.push('engine.pause');
            engineState = 'paused';
          },
          resumeEngine: () => {
            calls.push('engine.resume');
            engineState = 'playing';
            throw engineError;
          },
          pauseBuffer: () => calls.push('buffer.pause'),
          resumeBuffer: () => calls.push('buffer.resume'),
          isEnginePaused: () => engineState === 'paused',
        },
      ),
    ).rejects.toBe(engineError);

    expect(calls).toEqual(['W.resume', 'engine.resume', 'engine.pause', 'W.pause']);
    expect(state).toBe('paused');
    expect(engineState).toBe('paused');
  });

  it('compensates the buffer when buffer resume mutates then throws', async () => {
    const calls: string[] = [];
    const bufferError = new Error('buffer resume failed after mutation');
    let buffer: 'paused' | 'playing' = 'paused';

    await expect(
      resumeTeachingPlayback(
        {
          resume: async () => calls.push('W.resume'),
          pause: async () => calls.push('W.pause'),
        },
        {
          pauseEngine: () => calls.push('engine.pause'),
          resumeEngine: () => calls.push('engine.resume'),
          pauseBuffer: () => {
            calls.push('buffer.pause');
            buffer = 'paused';
          },
          resumeBuffer: () => {
            calls.push('buffer.resume');
            buffer = 'playing';
            throw bufferError;
          },
          isBufferPaused: () => buffer === 'paused',
        },
      ),
    ).rejects.toBe(bufferError);

    expect(calls).toEqual([
      'W.resume',
      'engine.resume',
      'buffer.resume',
      'buffer.pause',
      'engine.pause',
      'W.pause',
    ]);
    expect(buffer).toBe('paused');
  });

  it('surfaces both causes when W compensation fails', async () => {
    const operationCause = new Error('engine resume failed');
    const rollbackCause = new Error('W pause failed');

    await expect(
      resumeTeachingPlayback(
        {
          resume: async () => undefined,
          pause: async () => {
            throw rollbackCause;
          },
        },
        {
          pauseEngine: () => undefined,
          resumeEngine: () => {
            throw operationCause;
          },
          pauseBuffer: () => undefined,
          resumeBuffer: () => undefined,
        },
      ),
    ).rejects.toMatchObject({
      name: 'TeachingPlaybackControlError',
      operationCause,
      rollbackCause,
    } satisfies Partial<TeachingPlaybackControlError>);
  });
});
