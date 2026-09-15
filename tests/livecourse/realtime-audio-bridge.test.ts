import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getActiveLipSyncAudioNode,
  getActiveRealtimeAudioBridge,
  RealtimeAudioBridge,
  registerLipSyncAudioNode,
  registerRealtimeAudioBridge,
  subscribeRealtimeAudioBridge,
} from '@/lib/livecourse/realtime/client/audio-bridge';

let cleanupActiveBridge: (() => void) | null = null;

afterEach(() => {
  cleanupActiveBridge?.();
  cleanupActiveBridge = null;
});

describe('Realtime audio bridge registry', () => {
  it('keeps the newest bridge active when an older registration is released', () => {
    const first = {} as RealtimeAudioBridge;
    const second = {} as RealtimeAudioBridge;
    const listener = vi.fn();
    const unsubscribe = subscribeRealtimeAudioBridge(listener);
    const releaseFirst = registerRealtimeAudioBridge(first);
    cleanupActiveBridge = registerRealtimeAudioBridge(second);

    releaseFirst();

    expect(getActiveRealtimeAudioBridge()).toBe(second);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('publishes null before a registered bridge finishes closing', async () => {
    const audioElement = {
      autoplay: false,
      pause: vi.fn(),
      srcObject: null,
    } as unknown as HTMLAudioElement;
    const bridge = new RealtimeAudioBridge(audioElement);
    const snapshots: Array<RealtimeAudioBridge | null> = [];
    const unsubscribe = subscribeRealtimeAudioBridge(() => {
      snapshots.push(getActiveRealtimeAudioBridge());
    });
    cleanupActiveBridge = registerRealtimeAudioBridge(bridge);

    await bridge.close();

    expect(getActiveRealtimeAudioBridge()).toBeNull();
    expect(snapshots).toEqual([bridge, null]);
    expect(audioElement.pause).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('prefers a Volc playback tap over the OpenAI media-element bridge for lip-sync', () => {
    const tap = {} as AudioNode;
    const bridge = { audioNode: {} as AudioNode } as RealtimeAudioBridge;
    cleanupActiveBridge = registerRealtimeAudioBridge(bridge);
    const releaseTap = registerLipSyncAudioNode(tap);

    expect(getActiveLipSyncAudioNode()).toBe(tap);
    releaseTap();
    expect(getActiveLipSyncAudioNode()).toBe(bridge.audioNode);
  });
});
