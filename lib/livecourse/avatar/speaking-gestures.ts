import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { Euler, Quaternion, type Object3D } from 'three';

type BoneRole = 'shoulder' | 'upperArm' | 'lowerArm' | 'hand';
type Pose = Record<BoneRole, readonly [number, number, number]>;
type Phase = 'idle' | 'waiting' | 'gesturing' | 'returning';

// Local offsets for the left arm; mirror Y/Z for the right arm. Most movement
// comes from bending the elbow forward, keeping the upper arm near the torso.
const POSES: readonly Pose[] = [
  {
    shoulder: [0, -0.02, 0.025],
    upperArm: [-0.12, -0.2, 0.12],
    lowerArm: [0, -1.65, 0.06],
    hand: [0.12, -0.08, 0.08],
  },
  {
    shoulder: [0, -0.025, 0.035],
    upperArm: [-0.16, -0.24, 0.16],
    lowerArm: [0, -1.8, 0.1],
    hand: [0.2, -0.12, 0.12],
  },
  {
    shoulder: [0, -0.015, 0.02],
    upperArm: [-0.1, -0.16, 0.1],
    lowerArm: [0, -1.55, 0.04],
    hand: [0.08, -0.06, 0.06],
  },
];

const SILENCE_GRACE = 0.18;
const RETURN_DURATION = 0.35;

interface BoneOverlay {
  node: Object3D;
  baseline: Quaternion;
  offsets: Quaternion[];
  applied: boolean;
}

interface Arm {
  bones: BoneOverlay[];
}

function smoothstep(value: number): number {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

export class SpeakingGestures {
  #arms: Arm[] = [];
  #phase: Phase = 'idle';
  #elapsed = 0;
  #duration = 0;
  #silence = 0;
  #weight = 0;
  #returnWeight = 0;
  #activeArm: Arm | undefined;
  #nextArm = 0;
  #nextPose = 0;
  #pose = 0;
  #target = new Quaternion();

  constructor(humanoid: Pick<VRM['humanoid'], 'getNormalizedBoneNode'>) {
    const warnings: string[] = [];
    for (const side of ['left', 'right'] as const) {
      const definitions: readonly [BoneRole, VRMHumanBoneName][] = [
        ['shoulder', `${side}Shoulder`],
        ['upperArm', `${side}UpperArm`],
        ['lowerArm', `${side}LowerArm`],
        ['hand', `${side}Hand`],
      ];
      const nodes = definitions.map(([role, name]) => ({
        role,
        name,
        node: humanoid.getNormalizedBoneNode(name),
      }));
      const missing = nodes
        .filter(({ role, node }) => role !== 'shoulder' && !node)
        .map(({ name }) => name);
      if (missing.length > 0) {
        warnings.push(`${side} arm (missing ${missing.join(', ')})`);
        continue;
      }
      const mirror = side === 'left' ? 1 : -1;
      this.#arms.push({
        bones: nodes.flatMap(({ role, node }) =>
          node
            ? [
                {
                  node,
                  baseline: new Quaternion(),
                  offsets: POSES.map((pose) => {
                    const [x, y, z] = pose[role];
                    return new Quaternion().setFromEuler(new Euler(x, y * mirror, z * mirror));
                  }),
                  applied: false,
                },
              ]
            : [],
        ),
      });
    }
    if (warnings.length > 0) {
      console.warn(`Speaking gestures: skipping ${warnings.join('; ')}`);
    }
  }

  /** Call before AnimationMixer.update, including for bones without idle tracks. */
  restorePose(): void {
    for (const arm of this.#arms) {
      for (const bone of arm.bones) {
        if (!bone.applied) continue;
        bone.node.quaternion.copy(bone.baseline);
        bone.applied = false;
      }
    }
  }

  /** Call after AnimationMixer.update and before humanoid.update. */
  update(delta: number, speaking: boolean): void {
    if (this.#arms.length === 0) return;
    const dt = Number.isFinite(delta) ? Math.max(0, delta) : 0;
    if (speaking) {
      this.#silence = 0;
      if (this.#phase === 'idle') this.#wait(0.25 + Math.random() * 0.1);
    } else {
      this.#silence += dt;
      if (this.#silence >= SILENCE_GRACE && this.#phase !== 'returning') {
        if (this.#weight > 0) {
          this.#phase = 'returning';
          this.#elapsed = 0;
          this.#returnWeight = this.#weight;
        } else {
          this.#phase = 'idle';
          this.#elapsed = 0;
          this.#activeArm = undefined;
        }
      }
    }

    this.#elapsed += dt;
    if (this.#phase === 'waiting') {
      if (!speaking || this.#elapsed < this.#duration) return;
      this.#elapsed -= this.#duration;
      this.#duration = 2.2 + Math.random() * 0.5;
      this.#phase = 'gesturing';
      this.#activeArm = this.#arms[this.#nextArm];
      this.#nextArm = (this.#nextArm + 1) % this.#arms.length;
      this.#pose = this.#nextPose;
      this.#nextPose = (this.#nextPose + 1) % POSES.length;
    }
    if (this.#phase === 'gesturing') {
      const progress = this.#elapsed / this.#duration;
      if (progress >= 1) {
        this.#weight = 0;
        this.#activeArm = undefined;
        this.#wait(1.6 + Math.random() * 1.2);
        return;
      }
      this.#weight =
        progress < 0.32 ? smoothstep(progress / 0.32) : 1 - smoothstep((progress - 0.52) / 0.48);
    } else if (this.#phase === 'returning') {
      this.#weight = this.#returnWeight * (1 - smoothstep(this.#elapsed / RETURN_DURATION));
      if (this.#elapsed >= RETURN_DURATION) {
        this.#phase = 'idle';
        this.#elapsed = 0;
        this.#weight = 0;
        this.#activeArm = undefined;
      }
    }

    if (!this.#activeArm || this.#weight === 0) return;
    for (const bone of this.#activeArm.bones) {
      bone.baseline.copy(bone.node.quaternion);
      this.#target.copy(bone.baseline).multiply(bone.offsets[this.#pose]);
      bone.node.quaternion.slerpQuaternions(bone.baseline, this.#target, this.#weight);
      bone.applied = true;
    }
  }

  reset(): void {
    this.restorePose();
    this.#phase = 'idle';
    this.#elapsed = 0;
    this.#duration = 0;
    this.#silence = 0;
    this.#weight = 0;
    this.#returnWeight = 0;
    this.#activeArm = undefined;
    this.#nextArm = 0;
    this.#nextPose = 0;
    this.#pose = 0;
  }

  #wait(duration: number): void {
    this.#phase = 'waiting';
    this.#elapsed = 0;
    this.#duration = duration;
  }
}
