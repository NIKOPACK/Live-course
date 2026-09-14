import { describe, expect, it } from 'vitest';

import { buildPlaybackCompletionInput } from '@/lib/livecourse/session/playback-completion';

describe('buildPlaybackCompletionInput', () => {
  it('requires both committed speech boundaries', () => {
    expect(
      buildPlaybackCompletionInput({
        nodeId: 'node:scene-1',
        idempotencyKey: 'lesson-complete:node:scene-1',
        speechStartActionId: 'start-1',
      }),
    ).toBeNull();
  });

  it('builds a stable completion command once speech ended', () => {
    expect(
      buildPlaybackCompletionInput({
        nodeId: 'node:scene-1',
        idempotencyKey: 'lesson-complete:node:scene-1',
        speechStartActionId: 'start-1',
        speechEndActionId: 'end-1',
        actionIds: ['effect-1'],
      }),
    ).toEqual({
      nodeId: 'node:scene-1',
      idempotencyKey: 'lesson-complete:node:scene-1',
      speech: { startActionId: 'start-1', endActionId: 'end-1' },
      actionIds: ['effect-1'],
    });
  });

  it('uses committed speech boundaries when no additional actions were emitted', () => {
    expect(
      buildPlaybackCompletionInput({
        nodeId: 'node:scene-1',
        idempotencyKey: 'lesson-complete:node:scene-1',
        speechStartActionId: 'start-1',
        speechEndActionId: 'end-1',
      }),
    ).toMatchObject({
      actionIds: ['start-1', 'end-1'],
    });
  });
});
