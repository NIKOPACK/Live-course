/**
 * Vendored from moeru-ai/airi (see SOURCE.md).
 * Upstream: packages/stage-ui-three/src/composables/vrm/lip-sync.ts
 * Vue refs/watch/useAsyncState removed; AEIOU winner+runner blending,
 * smoothing constants and silence detection verbatim.
 */

import type { VRM } from '@pixiv/three-vrm';
import type { Profile, WLipSyncAudioNode } from 'wlipsync';

import profile from './lip-sync-profile.json';

// `wlipsync` extends AudioWorkletNode at module scope, so it must only load in
// browsers (and it inlines its WASM — keep it out of the initial bundle).
async function loadWLipSyncNode(audioContext: AudioContext): Promise<WLipSyncAudioNode> {
  const { createWLipSyncNode } = await import('wlipsync');
  return createWLipSyncNode(audioContext, profile as unknown as Profile);
}

// https://github.com/mrxz/wLipSync/blob/c3bc4b321dc7e1ca333d75f7aa1e9e746cbbb23a/example/index.js#L50-L66
const RAW_KEYS = ['A', 'E', 'I', 'O', 'U', 'S'] as const;
type LipKey = 'A' | 'E' | 'I' | 'O' | 'U';
const LIP_KEYS: LipKey[] = ['A', 'E', 'I', 'O', 'U'];
const BLENDSHAPE_MAP: Record<LipKey, string> = {
  A: 'aa',
  E: 'ee',
  I: 'ih',
  O: 'oh',
  U: 'ou',
};
const RAW_TO_LIP: Record<(typeof RAW_KEYS)[number], LipKey> = {
  A: 'A',
  E: 'E',
  I: 'I',
  O: 'O',
  U: 'U',
  S: 'I',
};

export class AiriVrmLipSync {
  #lipSyncNode: WLipSyncAudioNode | undefined;
  #audioNode: AudioNode | undefined;
  #smoothState: Record<LipKey, number> = { A: 0, E: 0, I: 0, O: 0, U: 0 };
  #lastActiveAt = 0;
  #speaking = false;

  static readonly ATTACK = 50; // the speed moving to the next mouth shape animation
  static readonly RELEASE = 30; // the speed ending the current mouth shape animation
  static readonly CAP = 0.7;
  static readonly SILENCE_VOL = 0.04;
  static readonly SILENCE_GAIN = 0.05;
  static readonly IDLE_MS = 160;

  get isSpeaking(): boolean {
    return this.#audioNode?.context.state === 'running' && this.#speaking;
  }

  async connect(audioNode: AudioNode): Promise<void> {
    this.disconnect();
    this.#audioNode = audioNode;
    const node = await loadWLipSyncNode(audioNode.context as AudioContext);
    // The audio source may have been swapped while the worklet loaded.
    if (this.#audioNode !== audioNode) {
      node.disconnect();
      return;
    }
    this.#lipSyncNode = node;
    try {
      audioNode.connect(node);
    } catch {
      // The source can already be closed by the realtime session.
    }
  }

  disconnect(): void {
    if (this.#audioNode && this.#lipSyncNode) {
      try {
        this.#audioNode.disconnect(this.#lipSyncNode);
      } catch {
        // The source can already be closed by the realtime session.
      }
    }
    this.#audioNode = undefined;
    this.#lipSyncNode = undefined;
    this.#smoothState = { A: 0, E: 0, I: 0, O: 0, U: 0 };
    this.#speaking = false;
    this.#lastActiveAt = 0;
  }

  update(vrm: Pick<VRM, 'expressionManager'> | undefined, delta = 0.016): void {
    const node = this.#lipSyncNode;
    if (!vrm?.expressionManager || !node) {
      this.#speaking = false;
      return;
    }

    const vol = node.volume ?? 0;
    const amp = Math.min(vol * 0.9, 1) ** 0.7;

    // Remapping wLipSync output AEIOUS to AEIOU
    const projected: Record<LipKey, number> = { A: 0, E: 0, I: 0, O: 0, U: 0 };
    for (const raw of RAW_KEYS) {
      const lip = RAW_TO_LIP[raw];
      const rawVal = node.weights[raw] ?? 0;
      projected[lip] = Math.max(projected[lip], rawVal * amp);
    }

    // winner + runner
    // Original code: all AEIOU mouth shape blended together. Because the A mouth shape has the largest deformation, mixing A-E-I-O-U based on their raw weights causes the combined result to be biased heavily toward A in most cases.
    // Improved code: Only the 2 mouth shapes with the largest weights will be blended.
    let winner: LipKey = 'I';
    let runner: LipKey = 'E';
    let winnerVal = -Infinity;
    let runnerVal = -Infinity;
    for (const key of LIP_KEYS) {
      const val = projected[key];
      if (val > winnerVal) {
        runnerVal = winnerVal;
        runner = winner;
        winnerVal = val;
        winner = key;
      } else if (val > runnerVal) {
        runnerVal = val;
        runner = key;
      }
    }

    // Detect pause or keep silence
    const now = performance.now();
    let silent = amp < AiriVrmLipSync.SILENCE_VOL || winnerVal < AiriVrmLipSync.SILENCE_GAIN;
    if (!silent) this.#lastActiveAt = now;
    if (now - this.#lastActiveAt > AiriVrmLipSync.IDLE_MS) silent = true;
    this.#speaking = !silent;

    // winner + runner weights
    const target: Record<LipKey, number> = { A: 0, E: 0, I: 0, O: 0, U: 0 };
    if (!silent) {
      target[winner] = Math.min(AiriVrmLipSync.CAP, winnerVal);
      target[runner] = Math.min(AiriVrmLipSync.CAP * 0.5, runnerVal * 0.6);
    }

    // smoothness and expression generation
    for (const key of LIP_KEYS) {
      const from = this.#smoothState[key];
      const to = target[key];
      // lerp
      const rate =
        1 - Math.exp(-(to > from ? AiriVrmLipSync.ATTACK : AiriVrmLipSync.RELEASE) * delta);
      this.#smoothState[key] = from + (to - from) * rate;
      const weight = (this.#smoothState[key] <= 0.01 ? 0 : this.#smoothState[key]) * 0.7;
      vrm.expressionManager.setValue(BLENDSHAPE_MAP[key], weight);
    }
  }
}
