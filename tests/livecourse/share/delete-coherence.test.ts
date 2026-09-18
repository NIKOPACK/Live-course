import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserKVStore } from '@livecourse/storage';
import {
  clearShareRedeemRegistration,
  readShareRedeemRegistration,
  setShareRegistrationStoreForTests,
  shareRedeemByStageKey,
  shareRedeemKey,
  writeShareRedeemRegistration,
} from '@/lib/livecourse/share/registration';

vi.mock('@/lib/utils/stage-storage', () => ({
  listStages: vi.fn(async () => [{ id: 'stage-copy' }]),
  loadStageData: vi.fn(async () => ({ stage: { id: 'stage-copy' }, scenes: [] })),
}));

describe('share delete registration', () => {
  afterEach(() => {
    setShareRegistrationStoreForTests(null);
  });

  it('clears both redeem keys for a stage', async () => {
    const storage = new Map<string, string>();
    const kv = new BrowserKVStore({
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          storage.set(key, value);
        },
        removeItem: (key) => {
          storage.delete(key);
        },
        clear: () => storage.clear(),
        key: (index) => [...storage.keys()][index] ?? null,
        get length() {
          return storage.size;
        },
      } as Storage,
    });
    setShareRegistrationStoreForTests(kv);
    await writeShareRedeemRegistration({
      token: 'tok',
      stageId: 'stage-copy',
      courseId: 'course-copy',
      lessonId: 'lesson-copy',
    });
    expect(await readShareRedeemRegistration('tok')).toMatchObject({
      stageId: 'stage-copy',
      lessonId: 'lesson-copy',
    });

    await clearShareRedeemRegistration('stage-copy');
    expect(await kv.get(shareRedeemKey('tok'), 'device')).toBeNull();
    expect(await kv.get(shareRedeemByStageKey('stage-copy'), 'device')).toBeNull();
    expect(await readShareRedeemRegistration('tok')).toBeNull();
  });
});
