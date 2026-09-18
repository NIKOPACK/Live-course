import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VRMExpressionManager } from '@pixiv/three-vrm';

const worklet = vi.hoisted(() => ({
  volume: 0,
  weights: { A: 0, E: 0, I: 0, O: 0, U: 0, S: 0 },
  disconnect: vi.fn(),
}));

vi.mock('wlipsync', () => ({
  createWLipSyncNode: vi.fn(async () => worklet),
}));

import { AiriVrmLipSync } from '@/lib/livecourse/avatar/vendor/airi/lip-sync';

const context = { state: 'running' };
const source = {
  context,
  connect: vi.fn(),
  disconnect: vi.fn(),
} as unknown as AudioNode;
const expressionManager = new VRMExpressionManager();
const setValue = vi.spyOn(expressionManager, 'setValue').mockImplementation(() => undefined);
let lipSync: AiriVrmLipSync;

beforeEach(() => {
  context.state = 'running';
  worklet.volume = 0;
  worklet.weights = { A: 0, E: 0, I: 0, O: 0, U: 0, S: 0 };
  setValue.mockClear();
  lipSync = new AiriVrmLipSync();
});

afterEach(() => lipSync.disconnect());

function speak(): void {
  worklet.volume = 0.5;
  worklet.weights.A = 0.8;
  lipSync.update({ expressionManager });
}

describe('VRM speech activity (J3.1 presentation only)', () => {
  it('does not treat an audio connection or silence as speech', async () => {
    expect(lipSync.isSpeaking).toBe(false);
    await lipSync.connect(source);
    lipSync.update({ expressionManager });
    expect(lipSync.isSpeaking).toBe(false);
  });

  it('exposes actual phoneme activity without changing mouth blending', async () => {
    await lipSync.connect(source);
    speak();

    expect(lipSync.isSpeaking).toBe(true);
    expect(setValue).toHaveBeenCalledWith('aa', expect.any(Number));
    const mouthWeight = setValue.mock.calls.find(([name]) => name === 'aa')?.[1];
    expect(mouthWeight).toBeGreaterThan(0);
    expect(mouthWeight).toBeLessThanOrEqual(AiriVrmLipSync.CAP);
  });

  it('returns inactive during silence and resumes for the next spoken phrase', async () => {
    await lipSync.connect(source);
    speak();
    worklet.volume = 0;
    lipSync.update({ expressionManager });
    expect(lipSync.isSpeaking).toBe(false);
    speak();
    expect(lipSync.isSpeaking).toBe(true);
  });

  it('does not treat loud non-phoneme audio as speech', async () => {
    await lipSync.connect(source);
    worklet.volume = 1;
    lipSync.update({ expressionManager });
    expect(lipSync.isSpeaking).toBe(false);
  });

  it('gates suspended/closed audio and clears activity on disconnect and reconnect', async () => {
    await lipSync.connect(source);
    speak();
    context.state = 'suspended';
    expect(lipSync.isSpeaking).toBe(false);
    context.state = 'closed';
    expect(lipSync.isSpeaking).toBe(false);
    context.state = 'running';
    lipSync.disconnect();
    expect(lipSync.isSpeaking).toBe(false);

    await lipSync.connect(source);
    expect(lipSync.isSpeaking).toBe(false);
    speak();
    expect(lipSync.isSpeaking).toBe(true);
  });

  it('clears stale activity when the model is unavailable', async () => {
    await lipSync.connect(source);
    speak();
    lipSync.update(undefined);
    expect(lipSync.isSpeaking).toBe(false);
  });
});
