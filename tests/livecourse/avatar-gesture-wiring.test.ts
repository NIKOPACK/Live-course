// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  audible: false,
  order: [] as string[],
  updateGesture: vi.fn(),
  restoreGesture: vi.fn(),
  resetGesture: vi.fn(),
  connectAudio: vi.fn(async (_node: AudioNode) => undefined),
  disconnectAudio: vi.fn(),
}));

vi.mock('three', async (importOriginal) => {
  const original = await importOriginal<typeof import('three')>();
  return {
    ...original,
    WebGLRenderer: class {
      renderLists = { dispose: vi.fn() };
      setClearColor() {}
      setPixelRatio() {}
      setSize() {}
      render() {}
      dispose() {}
      forceContextLoss() {}
    },
  };
});

vi.mock('@pixiv/three-vrm', () => ({
  VRMUtils: {
    deepDispose: vi.fn(),
    removeUnnecessaryVertices: vi.fn(),
    combineSkeletons: vi.fn(),
  },
}));

vi.mock('@/lib/livecourse/avatar/vendor/airi/loader', async () => {
  const { Group } = await import('three');
  return {
    createAiriVrmLoader: () => ({
      loadAsync: async () => ({
        userData: {
          vrm: {
            scene: new Group(),
            humanoid: {
              getNormalizedBoneNode: () => null,
              update: () => state.order.push('humanoid'),
            },
          },
        },
      }),
    }),
  };
});

vi.mock('@/lib/livecourse/avatar/vendor/airi/lip-sync', () => ({
  AiriVrmLipSync: class {
    get isSpeaking() {
      return state.audible;
    }
    connect = state.connectAudio;
    disconnect() {
      state.audible = false;
      state.disconnectAudio();
    }
    update() {
      state.order.push('lip-sync');
    }
  },
}));

import {
  ensureAiriVrmAvatarElement,
  type AiriVrmAvatarElementApi,
} from '@/lib/livecourse/avatar/airi-vrm-element';

let avatar: AiriVrmAvatarElementApi;
let frame: FrameRequestCallback | undefined;
let clock: number;

beforeEach(() => {
  vi.clearAllMocks();
  state.audible = false;
  state.order = [];
  clock = performance.now();
  frame = undefined;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  ensureAiriVrmAvatarElement();
  avatar = document.createElement('airi-vrm-avatar');
});

afterEach(() => {
  avatar.remove();
  vi.unstubAllGlobals();
});

async function mount(): Promise<void> {
  avatar.modelSrc = '/teacher.vrm';
  const ready = new Promise<void>((resolve) => {
    avatar.addEventListener('airi-vrm-status', () => {
      if (avatar.status === 'ready') resolve();
    });
  });
  document.body.append(avatar);
  await ready;
}

function tick(): void {
  clock += 16;
  frame?.(clock);
}

describe('VRM lecture rendering without speaking arm gestures', () => {
  it('updates idle, humanoid and lip-sync without overlaying arm poses', async () => {
    await mount();
    state.order = [];
    state.audible = true;
    tick();
    expect(state.order).toEqual(['humanoid', 'lip-sync']);
    expect(state.updateGesture).not.toHaveBeenCalled();
    expect(state.restoreGesture).not.toHaveBeenCalled();
  });

  it('keeps lip-sync after audio disconnect', async () => {
    await mount();
    state.audible = true;
    tick();
    avatar.disconnectAudio();
    state.order = [];
    tick();
    expect(state.order).toEqual(['humanoid', 'lip-sync']);
    expect(state.resetGesture).not.toHaveBeenCalled();
  });

  it('cleans up the animation loop on unmount', async () => {
    await mount();
    avatar.modelSrc = '';
    tick();
    expect(state.updateGesture).not.toHaveBeenCalled();

    avatar.remove();
    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(state.disconnectAudio).toHaveBeenCalled();
  });

  it('reports unavailable speech animation without failing or completing the classroom', async () => {
    await mount();
    const error = new Error('worklet failed');
    state.connectAudio.mockRejectedValueOnce(error);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const warning = vi.fn();
    avatar.addEventListener('airi-vrm-warning', warning);
    try {
      avatar.connectAudio({} as AudioNode);
      await Promise.resolve();
      expect(warn).toHaveBeenCalledWith(
        'Teacher lip-sync unavailable',
        error,
      );
      expect(warning).toHaveBeenCalledOnce();
      expect(avatar.status).toBe('ready');
    } finally {
      warn.mockRestore();
    }
  });
});
