import { BrowserKVStore, type KVStore } from '@livecourse/storage';
import { listStages, loadStageData } from '@/lib/utils/stage-storage';

export const SHARE_REDEEM_KEY_PREFIX = 'share.redeems.';
export const SHARE_REDEEM_BY_STAGE_PREFIX = 'share.redeemByStage.';

export interface ShareRedeemRecord {
  stageId: string;
  courseId: string;
  lessonId: string;
  redeemedAt: string;
}

let defaultKv: KVStore | undefined;

function kv(): KVStore {
  return (defaultKv ??= new BrowserKVStore());
}

export function setShareRegistrationStoreForTests(store: KVStore | null): void {
  defaultKv = store ?? undefined;
}

export function shareRedeemKey(token: string): string {
  return `${SHARE_REDEEM_KEY_PREFIX}${token}`;
}

export function shareRedeemByStageKey(stageId: string): string {
  return `${SHARE_REDEEM_BY_STAGE_PREFIX}${stageId}`;
}

export async function readShareRedeemRegistration(
  token: string,
): Promise<ShareRedeemRecord | null> {
  const record = await kv().get<ShareRedeemRecord>(shareRedeemKey(token), 'device');
  if (!record?.stageId || !record.lessonId) {
    if (record?.stageId) await clearShareRedeemRegistration(record.stageId);
    return null;
  }
  const listed = (await listStages()).some((item) => item.id === record.stageId);
  const loaded = listed ? await loadStageData(record.stageId) : null;
  if (!listed || !loaded) {
    await clearShareRedeemRegistration(record.stageId);
    return null;
  }
  return record;
}

export async function writeShareRedeemRegistration(input: {
  token: string;
  stageId: string;
  courseId: string;
  lessonId: string;
}): Promise<void> {
  const record: ShareRedeemRecord = {
    stageId: input.stageId,
    courseId: input.courseId,
    lessonId: input.lessonId,
    redeemedAt: new Date().toISOString(),
  };
  await kv().set(shareRedeemKey(input.token), record, 'device');
  await kv().set(shareRedeemByStageKey(input.stageId), { token: input.token }, 'device');
}

export async function clearShareRedeemRegistration(stageId: string): Promise<void> {
  const store = kv();
  const reverse = await store.get<{ token?: string }>(shareRedeemByStageKey(stageId), 'device');
  if (reverse?.token) {
    await store.remove(shareRedeemKey(reverse.token), 'device');
  }
  await store.remove(shareRedeemByStageKey(stageId), 'device');
}
