import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserKVStore } from '@livecourse/storage';

let failWrites = false;
let backing: Map<string, string>;
const localStorageStub: Storage = {
  get length() {
    return backing.size;
  },
  getItem: (key) => backing.get(key) ?? null,
  setItem: (key, value) => {
    if (failWrites) throw new Error('storage quota exhausted');
    backing.set(key, value);
  },
  removeItem: (key) => void backing.delete(key),
  clear: () => backing.clear(),
  key: (index) => [...backing.keys()][index] ?? null,
};
const kv = new BrowserKVStore({ storage: localStorageStub });
const NAME = 'settings-storage';

beforeEach(() => {
  backing = new Map();
  failWrites = false;
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', localStorageStub);
  vi.stubGlobal('window', { localStorage: localStorageStub });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('explicit settings Save through the real store and KV seam (S1 settings)', () => {
  it('preserves an automatic playback-speed update made during a credential Save', async () => {
    const { useSettingsStore: store, saveSettings } = await import('@/lib/store/settings');
    await store.persist.rehydrate();
    await saveSettings((state) => state.setPlaybackSpeed(1));
    const rehydrate = vi.spyOn(store.persist, 'rehydrate');

    const saving = saveSettings((state) =>
      state.setProviderConfig('openai', { baseUrl: 'https://settings-save.test/v1' }),
    );
    // No timer race: this synchronous auto-write lands while Save is pending.
    const automaticWrite = store.getState().setPlaybackSpeed(1.5);
    await Promise.all([saving, automaticWrite]);
    const persisted = await kv.get<{ state: Record<string, unknown> }>(NAME, 'account');

    expect(store.getState().playbackSpeed).toBe(1.5);
    expect(persisted?.state).toMatchObject({
      playbackSpeed: 1.5,
      providersConfig: { openai: { baseUrl: 'https://settings-save.test/v1' } },
    });
    await vi.runAllTimersAsync();
    expect(rehydrate).not.toHaveBeenCalled();
  });

  it('reports failure after exhaustion, schedules recovery on user retry, then saves again', async () => {
    const { useSettingsStore: store, saveSettings } = await import('@/lib/store/settings');
    const { DEFAULT_RECOVERY_BACKOFF_MS } = await import('@/lib/store/kv-persist');
    await store.persist.rehydrate();
    await saveSettings((state) => state.setPlaybackSpeed(1));
    const rehydrate = vi.spyOn(store.persist, 'rehydrate');
    failWrites = true;

    await expect(saveSettings((state) => state.setPlaybackSpeed(1.25))).rejects.toThrow(
      /Could not persist/,
    );
    await vi.runAllTimersAsync();
    expect(rehydrate).toHaveBeenCalledTimes(DEFAULT_RECOVERY_BACKOFF_MS.length);

    failWrites = false;
    // The gate is still closed: this submission must fail even though it asks
    // the existing recovery callback to try again in a later task.
    await expect(saveSettings((state) => state.setPlaybackSpeed(1.5))).rejects.toThrow(
      /Could not persist/,
    );
    expect(rehydrate).toHaveBeenCalledTimes(DEFAULT_RECOVERY_BACKOFF_MS.length);
    await vi.runAllTimersAsync();
    expect(rehydrate).toHaveBeenCalledTimes(DEFAULT_RECOVERY_BACKOFF_MS.length + 1);

    await expect(saveSettings((state) => state.setPlaybackSpeed(1.5))).resolves.toBeUndefined();
    expect(await kv.get(NAME, 'account')).toMatchObject({ state: { playbackSpeed: 1.5 } });
  });

  it('persists a Realtime API key through explicit Save without touching learning memory', async () => {
    const { useSettingsStore: store, saveSettings } = await import('@/lib/store/settings');
    await store.persist.rehydrate();

    await saveSettings((state) =>
      state.setRealtimeProviderConfig('openai', { apiKey: 'sk-realtime-saved' }),
    );
    const persisted = await kv.get<{ state: Record<string, unknown> }>(NAME, 'account');

    expect(store.getState().realtimeProvidersConfig.openai.apiKey).toBe('sk-realtime-saved');
    expect(persisted?.state).toMatchObject({
      realtimeProvidersConfig: { openai: { apiKey: 'sk-realtime-saved' } },
    });
  });
});
