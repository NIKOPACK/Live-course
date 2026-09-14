import { describe, expect, it } from 'vitest';

import { hasPlayableSceneActions } from '@/lib/playback/scene-playability';

describe('hasPlayableSceneActions', () => {
  it('keeps a legacy slide with omitted actions playable via the synthetic dwell', () => {
    expect(
      hasPlayableSceneActions({
        type: 'slide',
        actions: undefined,
      }),
    ).toBe(true);
  });

  it('keeps an explicitly empty slide playable', () => {
    expect(hasPlayableSceneActions({ type: 'slide', actions: [] })).toBe(true);
  });

  it('keeps actionless replay scenes playable via the synthetic dwell', () => {
    expect(hasPlayableSceneActions({ type: 'quiz', actions: undefined })).toBe(true);
    expect(hasPlayableSceneActions({ type: 'interactive', actions: [] })).toBe(true);
    expect(hasPlayableSceneActions({ type: 'pbl', actions: undefined })).toBe(true);
    expect(hasPlayableSceneActions(null)).toBe(false);
  });
});
