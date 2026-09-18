import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import {
  AnimationClip,
  AnimationMixer,
  Euler,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
} from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpeakingGestures } from '@/lib/livecourse/avatar/speaking-gestures';

const BONE_NAMES = [
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'head',
  'hips',
  'spine',
  'leftUpperLeg',
  'leftIndexProximal',
] as const satisfies readonly VRMHumanBoneName[];

type BoneName = (typeof BONE_NAMES)[number];
const DT = 1 / 60;

function createRig(missing: readonly VRMHumanBoneName[] = []) {
  const root = new Object3D();
  const bones = {
    leftShoulder: new Object3D(),
    leftUpperArm: new Object3D(),
    leftLowerArm: new Object3D(),
    leftHand: new Object3D(),
    rightShoulder: new Object3D(),
    rightUpperArm: new Object3D(),
    rightLowerArm: new Object3D(),
    rightHand: new Object3D(),
    head: new Object3D(),
    hips: new Object3D(),
    spine: new Object3D(),
    leftUpperLeg: new Object3D(),
    leftIndexProximal: new Object3D(),
  };
  const nodes = new Map<VRMHumanBoneName, Object3D>();
  for (const name of BONE_NAMES) {
    bones[name].name = name;
    if (!missing.includes(name)) nodes.set(name, bones[name]);
  }

  root.add(bones.hips);
  bones.hips.position.y = 0.9;
  bones.hips.add(bones.spine, bones.leftUpperLeg);
  bones.spine.position.y = 0.2;
  bones.spine.add(bones.head, bones.leftShoulder, bones.rightShoulder);
  bones.head.position.y = 0.48;
  bones.head.rotation.set(0.08, -0.1, 0.07);
  bones.leftUpperLeg.rotation.set(0.01, 0.02, 0.03);
  bones.leftUpperLeg.position.set(0.08, 0, 0);
  bones.leftIndexProximal.rotation.set(0.04, 0.03, 0.02);
  for (const side of ['left', 'right'] as const) {
    const sign = side === 'left' ? 1 : -1;
    const shoulder = bones[`${side}Shoulder`];
    const upper = bones[`${side}UpperArm`];
    const lower = bones[`${side}LowerArm`];
    const hand = bones[`${side}Hand`];
    shoulder.position.set(sign * 0.1, 0.3, 0);
    shoulder.add(upper);
    upper.position.x = sign * 0.05;
    upper.add(lower);
    lower.position.x = sign * 0.26;
    lower.add(hand);
    hand.position.x = sign * 0.24;
  }
  bones.leftHand.add(bones.leftIndexProximal);
  bones.leftIndexProximal.position.x = 0.07;

  // First idle_loop.vrma sample, with a mirrored shoulder/hand on the right.
  bones.leftShoulder.quaternion.set(0.018, -0.028, -0.049, 0.998).normalize();
  bones.leftUpperArm.quaternion.set(0.004, -0.053, -0.614, 0.787).normalize();
  bones.leftLowerArm.quaternion.set(0.001, -0.051, 0.01, 0.999).normalize();
  bones.leftHand.quaternion.set(-0.175, -0.013, 0.007, 0.984).normalize();
  bones.rightShoulder.quaternion.set(0.018, 0.028, 0.049, 0.998).normalize();
  bones.rightUpperArm.quaternion.set(-0.019, 0.087, 0.597, 0.797).normalize();
  bones.rightLowerArm.quaternion.set(0.001, 0.059, -0.012, 0.998).normalize();
  bones.rightHand.quaternion.set(-0.175, 0.013, -0.007, 0.984).normalize();

  const initial = new Map(BONE_NAMES.map((name) => [name, bones[name].quaternion.clone()]));
  const baseline = (name: BoneName) => {
    const quaternion = initial.get(name);
    if (!quaternion) throw new Error(`Missing test baseline for ${name}`);
    return quaternion;
  };
  const getNormalizedBoneNode = vi.fn((name: VRMHumanBoneName) => nodes.get(name) ?? null);
  const humanoid: Pick<VRM['humanoid'], 'getNormalizedBoneNode'> = { getNormalizedBoneNode };
  const gestures = new SpeakingGestures(humanoid);
  const frame = (speaking: boolean, delta = DT) => {
    gestures.restorePose();
    gestures.update(delta, speaking);
  };
  const advance = (seconds: number, speaking: boolean) => {
    for (let frameIndex = 0; frameIndex < Math.round(seconds / DT); frameIndex++) frame(speaking);
  };
  const angle = (name: BoneName) => bones[name].quaternion.angleTo(baseline(name));
  return { root, bones, baseline, getNormalizedBoneNode, gestures, frame, advance, angle };
}

type Rig = ReturnType<typeof createRig>;

function expectQuaternion(actual: Quaternion, expected: Quaternion): void {
  const sign = actual.dot(expected) < 0 ? -1 : 1;
  const components = actual.toArray();
  expected.toArray().forEach((value, index) => {
    expect(components[index]).toBeCloseTo(value * sign, 10);
  });
}

function expectRest(rig: Rig): void {
  for (const name of BONE_NAMES) expectQuaternion(rig.bones[name].quaternion, rig.baseline(name));
}

function idleMixer(rig: Rig): AnimationMixer {
  const tracks = ['leftUpperArm', 'rightUpperArm', 'head', 'hips'].map((name) => {
    const node = rig.root.getObjectByName(name);
    if (!node) throw new Error(`Missing test animation node ${name}`);
    const start = node.quaternion.clone();
    const end = start.clone().multiply(new Quaternion().setFromEuler(new Euler(0.07, -0.04, 0.06)));
    return new QuaternionKeyframeTrack(
      `${name}.quaternion`,
      [0, 0.75, 1.5],
      [...start.toArray(), ...end.toArray(), ...start.toArray()],
    );
  });
  const mixer = new AnimationMixer(rig.root);
  mixer.clipAction(new AnimationClip('idle', 1.5, tracks)).play();
  return mixer;
}

describe('SpeakingGestures', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves idle unchanged and caches only the eight arm bone lookups', () => {
    const rig = createRig();
    const randomCalls = vi.mocked(Math.random).mock.calls.length;
    rig.advance(10, false);
    expectRest(rig);
    expect(rig.getNormalizedBoneNode.mock.calls.map(([name]) => name)).toEqual(
      BONE_NAMES.slice(0, 8),
    );
    expect(Math.random).toHaveBeenCalledTimes(randomCalls);
  });

  it.each([0, 0.5, 0.999])('has a brief, bounded onset at cadence variation %s', (variation) => {
    vi.mocked(Math.random).mockReturnValue(variation);
    const rig = createRig();
    rig.advance(0.2, true);
    expectRest(rig);
    rig.advance(0.2, true);
    expect(rig.angle('leftLowerArm')).toBeGreaterThan(0.005);
    rig.advance(0.8, true);
    expect(rig.angle('leftLowerArm')).toBeGreaterThan(1.5);
    expect(rig.angle('leftUpperArm')).toBeGreaterThan(0.15);
    expect(rig.angle('leftUpperArm')).toBeLessThan(0.4);
    expect(rig.angle('leftShoulder')).toBeLessThan(0.06);
    expect(rig.angle('leftHand')).toBeGreaterThan(0.1);
    expectQuaternion(rig.bones.rightLowerArm.quaternion, rig.baseline('rightLowerArm'));
  });

  it('raises each hand into the lower portrait without crossing the torso or reaching the face', () => {
    const rig = createRig();
    const idleLeft = rig.bones.leftHand.getWorldPosition(new Vector3());
    const idleRight = rig.bones.rightHand.getWorldPosition(new Vector3());
    rig.advance(1.2, true);
    const left = rig.bones.leftHand.getWorldPosition(new Vector3());
    expect(left.y - idleLeft.y).toBeGreaterThan(0.25);
    expect(left.y).toBeGreaterThan(1.1);
    expect(left.y).toBeLessThan(1.4);
    expect(left.x).toBeGreaterThan(0.08);
    expect(left.x).toBeLessThan(0.4);
    expect(left.z - idleLeft.z).toBeGreaterThan(0.15);

    rig.advance(4.9, true);
    const right = rig.bones.rightHand.getWorldPosition(new Vector3());
    expect(right.y - idleRight.y).toBeGreaterThan(0.25);
    expect(right.y).toBeGreaterThan(1.1);
    expect(right.y).toBeLessThan(1.4);
    expect(right.x).toBeLessThan(-0.08);
    expect(right.x).toBeGreaterThan(-0.4);
    expect(right.z - idleRight.z).toBeGreaterThan(0.15);
  });

  it('alternates sides and restrained poses with smooth envelopes and deliberate rest gaps', () => {
    const rig = createRig();
    const randomCalls = vi.mocked(Math.random).mock.calls.length;
    const windows: { side: string; start: number; end: number; peak: number; hold: number }[] = [];
    let active: (typeof windows)[number] | undefined;
    let previousLeft = rig.bones.leftLowerArm.quaternion.clone();
    let previousRight = rig.bones.rightLowerArm.quaternion.clone();
    for (let frame = 0; frame < 1800; frame++) {
      rig.frame(true);
      const time = (frame + 1) * DT;
      const left = rig.angle('leftLowerArm');
      const right = rig.angle('rightLowerArm');
      const side = left > 1e-5 ? 'left' : right > 1e-5 ? 'right' : undefined;
      expect(left > 1e-5 && right > 1e-5).toBe(false);
      expect(rig.bones.leftLowerArm.quaternion.angleTo(previousLeft)).toBeLessThan(0.07);
      expect(rig.bones.rightLowerArm.quaternion.angleTo(previousRight)).toBeLessThan(0.07);
      previousLeft = rig.bones.leftLowerArm.quaternion.clone();
      previousRight = rig.bones.rightLowerArm.quaternion.clone();
      if (side) {
        if (!active) active = { side, start: time, end: time, peak: 0, hold: 0 };
        const angle = Math.max(left, right);
        if (Math.abs(active.peak - angle) < 1e-6) active.hold += DT;
        active.peak = Math.max(active.peak, angle);
        active.end = time;
      } else if (active) {
        windows.push(active);
        active = undefined;
      }
    }
    expect(windows.length).toBeGreaterThanOrEqual(6);
    expect(windows.slice(0, 6).map(({ side }) => side)).toEqual([
      'left',
      'right',
      'left',
      'right',
      'left',
      'right',
    ]);
    for (let index = 0; index < windows.length; index++) {
      const window = windows[index];
      expect(window.end - window.start).toBeGreaterThan(2);
      expect(window.end - window.start).toBeLessThan(3);
      expect(window.hold).toBeGreaterThan(0.3);
      expect(window.peak).toBeGreaterThan(1.5);
      expect(window.peak).toBeLessThan(1.85);
      if (index > 0) {
        const gap = window.start - windows[index - 1].end;
        expect(gap).toBeGreaterThan(1.5);
        expect(gap).toBeLessThan(3);
      }
    }
    expect(windows[1].peak - windows[0].peak).toBeGreaterThan(0.1);
    expect(windows[0].peak - windows[2].peak).toBeGreaterThan(0.08);
    expect(windows[3].peak).toBeCloseTo(windows[0].peak, 5);
    expect(vi.mocked(Math.random).mock.calls.length - randomCalls).toBeLessThan(20);
  });

  it('does not advance or jitter when frame delta is zero', () => {
    const rig = createRig();
    rig.advance(1, true);
    const pose = rig.bones.leftLowerArm.quaternion.clone();
    const randomCalls = vi.mocked(Math.random).mock.calls.length;
    for (let index = 0; index < 100; index++) rig.frame(index % 2 === 0, 0);
    expectQuaternion(rig.bones.leftLowerArm.quaternion, pose);
    expect(Math.random).toHaveBeenCalledTimes(randomCalls);
  });

  it('bridges short intra-word silence instead of repeatedly restarting', () => {
    const continuous = createRig();
    const intermittent = createRig();
    continuous.advance(0.8, true);
    intermittent.advance(0.8, true);
    const randomCalls = vi.mocked(Math.random).mock.calls.length;
    for (let index = 0; index < 72; index++) {
      continuous.frame(true);
      intermittent.frame(index % 24 >= 6);
      expectQuaternion(
        intermittent.bones.leftLowerArm.quaternion,
        continuous.bones.leftLowerArm.quaternion,
      );
    }
    expect(Math.random).toHaveBeenCalledTimes(randomCalls);
  });

  it.each([DT, 0.1])('returns smoothly within 0.6s of silence at frame delta %s', (delta) => {
    const rig = createRig();
    rig.advance(1.2, true);
    let previous = rig.bones.leftLowerArm.quaternion.clone();
    let previousAngle = rig.angle('leftLowerArm');
    rig.frame(false, delta);
    expectQuaternion(rig.bones.leftLowerArm.quaternion, previous);
    for (let elapsed = delta; elapsed < 0.6; elapsed += delta) {
      rig.frame(false, delta);
      expect(rig.angle('leftLowerArm')).toBeLessThanOrEqual(previousAngle + 1e-6);
      expect(rig.bones.leftLowerArm.quaternion.angleTo(previous)).toBeLessThan(8 * delta);
      previous = rig.bones.leftLowerArm.quaternion.clone();
      previousAngle = rig.angle('leftLowerArm');
    }
    expectRest(rig);
    const randomCalls = vi.mocked(Math.random).mock.calls.length;
    rig.advance(2, false);
    expect(Math.random).toHaveBeenCalledTimes(randomCalls);
    expectRest(rig);
    rig.advance(0.2, true);
    expectRest(rig);
    rig.advance(1, true);
    expect(rig.angle('rightLowerArm')).toBeGreaterThan(1.5);
    rig.advance(0.6, false);
    expectRest(rig);
  });

  it('finishes a smooth return before restarting if speech resumes during release', () => {
    const rig = createRig();
    rig.advance(1.2, true);
    rig.advance(0.25, false);
    const interrupted = rig.bones.leftLowerArm.quaternion.clone();
    expect(rig.angle('leftLowerArm')).toBeGreaterThan(0.5);
    rig.frame(true, 0);
    expectQuaternion(rig.bones.leftLowerArm.quaternion, interrupted);
    let previous = interrupted;
    let sawRest = false;
    for (let index = 0; index < 90; index++) {
      rig.frame(true);
      expect(rig.bones.leftLowerArm.quaternion.angleTo(previous)).toBeLessThan(0.13);
      previous = rig.bones.leftLowerArm.quaternion.clone();
      if (rig.angle('leftLowerArm') < 1e-6 && rig.angle('rightLowerArm') < 1e-6) sawRest = true;
    }
    expect(sawRest).toBe(true);
    expect(rig.angle('rightLowerArm')).toBeGreaterThan(1.5);
    rig.advance(0.6, false);
    expectRest(rig);
  });

  it('never starts a waiting gesture after speech has stopped', () => {
    const rig = createRig();
    const randomCalls = vi.mocked(Math.random).mock.calls.length;
    rig.advance(0.2, true);
    rig.advance(1, false);
    expectRest(rig);
    expect(Math.random).toHaveBeenCalledTimes(randomCalls + 1);
    rig.advance(1.2, true);
    expect(rig.angle('leftLowerArm')).toBeGreaterThan(1.5);
  });

  it('reset immediately releases the current overlay and clears cadence', () => {
    const rig = createRig();
    rig.advance(1.2, true);
    expect(rig.angle('leftLowerArm')).toBeGreaterThan(1.5);
    rig.gestures.reset();
    expectRest(rig);
    rig.gestures.reset();
    rig.gestures.restorePose();
    expectRest(rig);
    rig.advance(0.2, true);
    expectRest(rig);
    rig.advance(1, true);
    expect(rig.angle('leftLowerArm')).toBeGreaterThan(1.5);
    expectQuaternion(rig.bones.rightLowerArm.quaternion, rig.baseline('rightLowerArm'));
  });

  it('samples the latest idle pose under an active overlay and restores it on reset', () => {
    const rig = createRig();
    rig.advance(1.2, true);
    const offset = rig
      .baseline('leftUpperArm')
      .clone()
      .invert()
      .multiply(rig.bones.leftUpperArm.quaternion);
    const nextIdlePose = new Quaternion().setFromEuler(new Euler(0.03, -0.1, -1.25));
    rig.gestures.restorePose();
    rig.bones.leftUpperArm.quaternion.copy(nextIdlePose);
    rig.gestures.update(0, true);
    expectQuaternion(rig.bones.leftUpperArm.quaternion, nextIdlePose.clone().multiply(offset));
    rig.gestures.reset();
    expectQuaternion(rig.bones.leftUpperArm.quaternion, nextIdlePose);
  });

  it('preserves moving mixer baselines and untracked bones without drift over hundreds of frames', () => {
    const rig = createRig();
    const reference = createRig();
    const mixer = idleMixer(rig);
    const referenceMixer = idleMixer(reference);
    let movingFrames = 0;
    for (let frame = 0; frame < 1800; frame++) {
      rig.gestures.restorePose();
      rig.gestures.restorePose();
      mixer.update(DT);
      referenceMixer.update(DT);
      for (const name of BONE_NAMES) {
        expectQuaternion(rig.bones[name].quaternion, reference.bones[name].quaternion);
      }
      rig.gestures.update(DT, frame % 420 < 300);
      if (
        rig.bones.leftLowerArm.quaternion.angleTo(reference.bones.leftLowerArm.quaternion) > 0.1 ||
        rig.bones.rightLowerArm.quaternion.angleTo(reference.bones.rightLowerArm.quaternion) > 0.1
      ) {
        movingFrames++;
      }
      for (const name of BONE_NAMES.slice(8)) {
        expectQuaternion(rig.bones[name].quaternion, reference.bones[name].quaternion);
      }
      for (const name of BONE_NAMES) {
        expect(rig.bones[name].position.toArray()).toEqual(
          reference.bones[name].position.toArray(),
        );
        expect(rig.bones[name].scale.toArray()).toEqual(reference.bones[name].scale.toArray());
      }
    }
    expect(movingFrames).toBeGreaterThan(500);
    rig.gestures.reset();
    for (const name of BONE_NAMES) {
      expectQuaternion(rig.bones[name].quaternion, reference.bones[name].quaternion);
    }
    expect(rig.getNormalizedBoneNode).toHaveBeenCalledTimes(8);
  });

  it.each([
    'leftUpperArm',
    'leftLowerArm',
    'leftHand',
    'rightUpperArm',
    'rightLowerArm',
    'rightHand',
  ] as const)('warns once for %s and animates only the remaining complete arm', (missing) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rig = createRig([missing]);
    const skippedSide = missing.startsWith('left') ? 'left' : 'right';
    const remainingSide = skippedSide === 'left' ? 'right' : 'left';
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `Speaking gestures: skipping ${skippedSide} arm (missing ${missing})`,
    );
    let peak = 0;
    for (let frame = 0; frame < 600; frame++) {
      rig.frame(true);
      peak = Math.max(peak, rig.angle(`${remainingSide}LowerArm`));
      for (const name of BONE_NAMES.filter((name) => name.startsWith(skippedSide))) {
        expectQuaternion(rig.bones[name].quaternion, rig.baseline(name));
      }
    }
    expect(peak).toBeGreaterThan(1.5);
    rig.advance(0.6, false);
    expectRest(rig);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('can use complete arm chains without optional shoulder bones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rig = createRig(['leftShoulder', 'rightShoulder']);
    rig.advance(1.2, true);
    expect(rig.angle('leftLowerArm')).toBeGreaterThan(1.5);
    rig.advance(4.9, true);
    expect(rig.angle('rightLowerArm')).toBeGreaterThan(1.5);
    expect(warn).not.toHaveBeenCalled();
    rig.gestures.reset();
    expectRest(rig);
  });

  it('reports both incomplete chains once and safely does nothing without usable arms', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rig = createRig(['leftHand', 'rightLowerArm']);
    const randomCalls = vi.mocked(Math.random).mock.calls.length;
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Speaking gestures: skipping left arm (missing leftHand); right arm (missing rightLowerArm)',
    );
    rig.advance(10, true);
    rig.advance(1, false);
    rig.gestures.reset();
    expectRest(rig);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(Math.random).toHaveBeenCalledTimes(randomCalls);
  });
});
