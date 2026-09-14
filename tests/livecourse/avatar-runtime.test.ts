// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import {
  AnimationClip,
  Object3D,
  PerspectiveCamera,
  QuaternionKeyframeTrack,
  Raycaster,
  Vector3,
  VectorKeyframeTrack,
} from 'three';

import {
  clearMouthExpressions,
  createAiriVrmStatusEvent,
  lookAtPosition,
  reAnchorRootPositionTrack,
  resolveExpressionName,
  type AiriVrmExpressionManager,
} from '@/lib/livecourse/avatar/airi-vrm-element';
import {
  AiriVrmEmote,
  createAiriEmotionStates,
} from '@/lib/livecourse/avatar/vendor/airi/expression';
import { randomSaccadeInterval } from '@/lib/livecourse/avatar/vendor/airi/eye-motions';
import { resolveAiriEyeFocus } from '@/lib/livecourse/avatar/vendor/airi/eye-tracking';
import {
  getVrmInteractionExpression,
  getVrmInteractionTargetFromObjectName,
  isClickLikePointerGesture,
} from '@/lib/livecourse/avatar/vendor/airi/interaction';
import { AiriVrmLipSync } from '@/lib/livecourse/avatar/vendor/airi/lip-sync';

function createExpressionManager(initial: Record<string, number>): {
  manager: AiriVrmExpressionManager;
  values: Record<string, number>;
} {
  const values = { ...initial };
  return {
    values,
    manager: {
      expressionMap: Object.fromEntries(Object.keys(values).map((name) => [name, {}])),
      getValue: (name) => values[name] ?? null,
      setValue: (name, value) => {
        values[name] = value;
      },
    },
  };
}

describe('AIRI VRM avatar runtime', () => {
  it('matches model expressions case-insensitively', () => {
    const expressionMap = { Neutral: {}, happy: {}, Blink: {} };

    expect(resolveExpressionName(expressionMap, ' HAPPY ')).toBe('happy');
    expect(resolveExpressionName(expressionMap, 'neutral')).toBe('Neutral');
    expect(resolveExpressionName(expressionMap, 'missing')).toBeNull();
  });

  it('maps AIRI mouth expressions to a cleared state when audio disconnects', () => {
    const { manager, values } = createExpressionManager({
      AA: 0.7,
      ee: 0.3,
      ih: 0.2,
      oh: 0.4,
      ou: 0.1,
      happy: 0.8,
    });

    clearMouthExpressions(manager);

    expect(values).toEqual({ AA: 0, ee: 0, ih: 0, oh: 0, ou: 0, happy: 0.8 });
  });

  it('blends AIRI emotion recipes from the current values (happy = happy 0.7 + aa 0.2)', () => {
    const { manager, values } = createExpressionManager({
      happy: 0,
      relaxed: 0.5,
      aa: 0,
    });
    const emote = new AiriVrmEmote({ expressionManager: manager });

    emote.setEmotion('happy');
    emote.update(10);

    expect(values.happy).toBeCloseTo(0.7, 5);
    expect(values.aa).toBeCloseTo(0.2, 5);
    expect(values.relaxed).toBeCloseTo(0, 5);
  });

  it('starts emotion transitions from displayed values instead of snapping to zero', () => {
    const { manager, values } = createExpressionManager({ happy: 0.7, sad: 0 });
    const emote = new AiriVrmEmote({ expressionManager: manager });

    emote.setEmotion('sad');
    emote.update(0.1);

    // Mid-transition: happy fades out gradually, not instantly.
    expect(values.happy).toBeGreaterThan(0);
    expect(values.happy).toBeLessThan(0.7);
    emote.update(10);
    expect(values.happy).toBeCloseTo(0, 5);
    expect(values.sad).toBeCloseTo(0.7, 5);
  });

  it('resets to neutral after the configured delay', () => {
    vi.useFakeTimers();
    try {
      const { manager, values } = createExpressionManager({ happy: 0, neutral: 0 });
      const emote = new AiriVrmEmote({ expressionManager: manager });

      emote.setEmotionWithResetAfter('happy', 3000);
      emote.update(10);
      expect(values.happy).toBeCloseTo(0.7, 5);

      vi.advanceTimersByTime(3000);
      emote.update(10);
      expect(values.happy).toBeCloseTo(0, 5);
      expect(values.neutral).toBeCloseTo(1, 5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns and keeps state for unknown emotions', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { manager, values } = createExpressionManager({ happy: 0.3 });
    const emote = new AiriVrmEmote({ expressionManager: manager });

    emote.setEmotion('missing');

    expect(warn).toHaveBeenCalled();
    emote.update(1);
    expect(values.happy).toBe(0.3);
    warn.mockRestore();
  });

  it('exposes the full AIRI emotion recipe set', () => {
    const states = createAiriEmotionStates();
    for (const name of ['happy', 'sad', 'angry', 'surprised', 'neutral', 'think', 'relaxed']) {
      expect(states.has(name)).toBe(true);
    }
  });

  it('generates saccade intervals in AIRI cadence bands', () => {
    for (let i = 0; i < 200; i++) {
      const interval = randomSaccadeInterval();
      expect(interval).toBeGreaterThanOrEqual(0);
      expect(interval).toBeLessThanOrEqual(4800);
    }
  });

  it('lip sync disconnect is safe without a prior connection', () => {
    const lipSync = new AiriVrmLipSync();
    expect(() => {
      lipSync.disconnect();
      lipSync.update(undefined);
    }).not.toThrow();
  });

  it('maps AIRI interaction targets to emotions like Stage.vue', () => {
    expect(getVrmInteractionExpression('head')).toBe('happy');
    expect(getVrmInteractionExpression('leftFoot')).toBe('relaxed');
    expect(getVrmInteractionExpression('rightFoot')).toBe('relaxed');
    expect(getVrmInteractionExpression('leftHand')).toBe('surprised');
    expect(getVrmInteractionExpression('rightUpperArm')).toBe('surprised');
  });

  it('parses collider names back into interaction targets', () => {
    expect(getVrmInteractionTargetFromObjectName('vrm_interaction_head')).toBe('head');
    expect(getVrmInteractionTargetFromObjectName('vrm_interaction_rightFoot')).toBe('rightFoot');
    expect(getVrmInteractionTargetFromObjectName('vrm_interaction_chest')).toBeNull();
    expect(getVrmInteractionTargetFromObjectName('mesh_42')).toBeNull();
  });

  it('recognizes click-like gestures only within the drag threshold', () => {
    expect(isClickLikePointerGesture({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(true);
    expect(isClickLikePointerGesture({ x: 0, y: 0 }, { x: 12, y: 0 })).toBe(false);
  });

  it('resolves AIRI eye focus per tracking mode', () => {
    const camera = new PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 1.2, 2.8);
    const raycaster = new Raycaster();
    const defaultLookAt = new Vector3(0, 1.45, 2.2);
    const screen = { top: 0, left: 0, width: 800, height: 600 };

    const cameraFocus = resolveAiriEyeFocus({
      trackingMode: 'camera',
      cameraPosition: camera.position,
      context: { raycaster, camera, defaultLookAt },
      screenBoundingBox: screen,
    });
    expect(cameraFocus.toArray()).toEqual([0, 1.2, 2.8]);

    const noneFocus = resolveAiriEyeFocus({
      trackingMode: 'none',
      cameraPosition: camera.position,
      context: { raycaster, camera, defaultLookAt },
      screenBoundingBox: screen,
      source: { x: 100, y: 100 },
    });
    expect(noneFocus).toBe(defaultLookAt);

    const mouseFocus = resolveAiriEyeFocus({
      trackingMode: 'mouse',
      cameraPosition: camera.position,
      context: { raycaster, camera, defaultLookAt },
      screenBoundingBox: screen,
      source: { x: 400, y: 300 },
    });
    expect(mouseFocus).not.toBe(defaultLookAt);
    expect(Number.isFinite(mouseFocus.x)).toBe(true);
  });

  it('re-anchors AIRI position tracks to the target VRM hips', () => {
    const hips = new Object3D();
    hips.name = 'Normalized_hips';
    hips.position.set(1, 2, 3);
    const hipsTrack = new VectorKeyframeTrack(
      'Normalized_hips.position',
      [0, 1],
      [10, 20, 30, 11, 21, 31],
    );
    const headTrack = new VectorKeyframeTrack('Normalized_head.position', [0], [100, 200, 300]);
    const rotationTrack = new QuaternionKeyframeTrack(
      'Normalized_head.quaternion',
      [0],
      [0, 0, 0, 1],
    );
    const clip = new AnimationClip('idle', 1, [hipsTrack, headTrack, rotationTrack]);
    const vrm = {
      humanoid: { getNormalizedBoneNode: () => hips },
    } as unknown as Parameters<typeof reAnchorRootPositionTrack>[1];

    reAnchorRootPositionTrack(clip, vrm);

    expect(Array.from(hipsTrack.values)).toEqual([1, 2, 3, 2, 3, 4]);
    expect(Array.from(headTrack.values)).toEqual([91, 182, 273]);
    expect(Array.from(rotationTrack.values)).toEqual([0, 0, 0, 1]);
  });

  it('creates stable gaze targets without sharing mutable vectors', () => {
    const first = lookAtPosition('slides');
    first.x = 99;

    expect(lookAtPosition('slides').toArray()).toEqual([-0.8, 1.35, 2.2]);
    expect(lookAtPosition('whiteboard').x).toBe(0.8);
  });

  it('emits a typed status event with an explicit failure reason', () => {
    const event = createAiriVrmStatusEvent('error', 'model failed');

    expect(event.type).toBe('airi-vrm-status');
    expect(event.detail).toEqual({ status: 'error', error: 'model failed' });
  });
});
