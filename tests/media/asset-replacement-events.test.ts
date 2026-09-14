import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAssetReplacementChannelForTesting,
  bindAssetReplacementChannel,
  notifyAssetReplaced,
  observeAssetReplacements,
  type AssetReplacementPool,
} from '@/lib/media/asset-replacement-events';

const pool: AssetReplacementPool = {
  resolve: vi.fn(async () => 'blob:refreshed'),
  release: vi.fn(async () => {}),
};

/**
 * Waits for `promise` inside a bounded window and rejects loudly on timeout, so
 * a regression that never delivers a BroadcastChannel message fails instead of
 * being slept past. Cleanup always happens in the caller's `finally`.
 */
async function withinDeliveryWindow(
  label: string,
  promise: Promise<unknown>,
  timeoutMs = 1_000,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

describe('asset replacement events', () => {
  afterEach(() => {
    __resetAssetReplacementChannelForTesting();
    vi.clearAllMocks();
  });

  it('notifies observers in the replacing realm', async () => {
    const observed: string[] = [];
    const stop = observeAssetReplacements((ref) => {
      observed.push(ref);
    });

    await notifyAssetReplaced('ast_local', pool);

    expect(observed).toEqual(['ast_local']);
    stop();
  });

  it('receives peer replacements in a realm that never sends one', async () => {
    // A passive tab only renders: it binds the channel when it starts observing,
    // never through the sender path.
    const refreshed: string[] = [];
    let resolveDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => {
      resolveDelivered = resolve;
    });
    const stop = observeAssetReplacements((ref) => {
      refreshed.push(ref);
      // The observer only runs once the peer message was actually delivered to
      // this realm's channel, so this is the delivery signal itself.
      resolveDelivered();
    });
    bindAssetReplacementChannel(() => pool);

    const peerChannel = new BroadcastChannel('livecourse-asset-replacements');
    try {
      peerChannel.postMessage('ast_from_peer');
      await withinDeliveryWindow('peer replacement delivery', delivered);

      expect(refreshed).toEqual(['ast_from_peer']);
    } finally {
      peerChannel.close();
      stop();
    }
  });

  it('keeps a failing observer from failing the committed replacement', async () => {
    // The durable write has already committed by the time observers run.
    const stopFailing = observeAssetReplacements(() => {
      throw new Error('stale dynamic import');
    });
    const seen: string[] = [];
    const stopHealthy = observeAssetReplacements((ref) => {
      seen.push(ref);
    });

    try {
      await expect(notifyAssetReplaced('ast_committed', pool)).resolves.toBeUndefined();
      expect(seen).toEqual(['ast_committed']);
    } finally {
      stopFailing();
      stopHealthy();
    }
  });

  it('propagates a same-id replacement to a mounted consumer in another realm', async () => {
    // Tab B: a consumer holding a lease, listening on its own channel instance.
    // The module-local observer set is shared in-process, so the peer realm is
    // modelled by a second channel that mirrors what tab B's module would do.
    const refreshedInPeerTab: string[] = [];
    const peerChannel = new BroadcastChannel('livecourse-asset-replacements');
    let resolveDelivered!: (data: string) => void;
    const delivered = new Promise<string>((resolve) => {
      resolveDelivered = resolve;
    });
    peerChannel.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        refreshedInPeerTab.push(event.data);
        resolveDelivered(event.data);
      }
    };

    try {
      // Tab A: its module bound the channel on load, then it replaces the bytes.
      bindAssetReplacementChannel(() => pool);
      await notifyAssetReplaced('ast_shared', pool);
      // The peer's own channel event is the delivery signal; no fixed sleep.
      await withinDeliveryWindow('peer replacement delivery', delivered);

      expect(refreshedInPeerTab).toEqual(['ast_shared']);
    } finally {
      peerChannel.close();
    }
  });

  it('still notifies local observers when the channel is unavailable', async () => {
    const original = globalThis.BroadcastChannel;
    // @ts-expect-error - modelling an environment without the API
    delete globalThis.BroadcastChannel;
    const observed: string[] = [];
    const stop = observeAssetReplacements((ref) => {
      observed.push(ref);
    });

    await expect(notifyAssetReplaced('ast_no_channel', pool)).resolves.toBeUndefined();

    expect(observed).toEqual(['ast_no_channel']);
    stop();
    globalThis.BroadcastChannel = original;
  });
});
