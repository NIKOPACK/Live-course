// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  audible: false,
  reducedMotion: false,
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

vi.mock('@/lib/livecourse/avatar/speaking-gestures', () => ({
  SpeakingGestures: class {
    restorePose() {
      state.order.push('restore');
      state.restoreGesture();
    }
    update(delta: number, speaking: boolean) {
      state.order.push('gesture');
      state.updateGesture(delta, speaking);
    }
    reset = state.resetGesture;
  },
}));

import {
  ensureAiriVrmAvatarElement,
  type AiriVrmAvatarElementApi,
} from '@/lib/livecourse/avatar/airi-vrm-element';

let avatar: AiriVrmAvatarElementApi;
let frame: FrameRequestCallback | undefined;
let clock: number;
let motionListeners: Set<() => void>;
let removeMotionListener: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  state.audible = false;
  state.reducedMotion = false;
  state.order = [];
  clock = performance.now();
  frame = undefined;
  motionListeners = new Set();
  removeMotionListener = vi.fn((_type: string, listener: () => void) => {
    motionListeners.delete(listener);
  });
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return state.reducedMotion;
    },
    addEventListener: (_type: string, listener: () => void) => motionListeners.add(listener),
    removeEventListener: removeMotionListener,
  }));
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

describe('VRM gesture wiring (J3.1)', () => {
  it('gates gestures on real audio, restores before animation, and applies before humanoid sync', async () => {
    await mount();
    tick();
    expect(state.updateGesture).toHaveBeenLastCalledWith(expect.any(Number), false);
    state.order = [];
    state.audible = true;
    tick();
    expect(state.updateGesture).toHaveBeenLastCalledWith(expect.any(Number), true);
    expect(state.order).toEqual(['restore', 'gesture', 'humanoid', 'lip-sync']);

    state.audible = false;
    tick();
    expect(state.updateGesture).toHaveBeenLastCalledWith(expect.any(Number), false);
  });

  it('disconnects audio without snapping the gesture, allowing the next frames to return to idle', async () => {
    await mount();
    state.audible = true;
    tick();
    state.resetGesture.mockClear();
    avatar.disconnectAudio();
    tick();
    expect(state.updateGesture).toHaveBeenLastCalledWith(expect.any(Number), false);
    expect(state.resetGesture).not.toHaveBeenCalled();
  });

  it('honors reduced motion on mount and when the preference changes in either direction', async () => {
    state.reducedMotion = true;
    await mount();
    state.audible = true;
    tick();
    expect(state.updateGesture).not.toHaveBeenCalled();
    expect(state.order).toContain('lip-sync');
    expect(state.order).toContain('humanoid');

    state.reducedMotion = false;
    motionListeners.forEach((listener) => listener());
    tick();
    expect(state.updateGesture).toHaveBeenLastCalledWith(expect.any(Number), true);

    state.reducedMotion = true;
    motionListeners.forEach((listener) => listener());
    expect(state.resetGesture).toHaveBeenCalled();
    state.updateGesture.mockClear();
    tick();
    expect(state.updateGesture).not.toHaveBeenCalled();
  });

  it('cleans up gesture state on model changes and listeners on unmount', async () => {
    await mount();
    state.resetGesture.mockClear();
    avatar.modelSrc = '';
    expect(state.resetGesture).toHaveBeenCalledOnce();
    state.updateGesture.mockClear();
    tick();
    expect(state.updateGesture).not.toHaveBeenCalled();

    avatar.remove();
    expect(removeMotionListener).toHaveBeenCalledOnce();
    expect(motionListeners.size).toBe(0);
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
        'Teacher lip-sync and speaking gestures unavailable',
        error,
      );
      expect(warning).toHaveBeenCalledOnce();
      expect(avatar.status).toBe('ready');
    } finally {
      warn.mockRestore();
    }
  });
});
