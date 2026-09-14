import { RuntimeAppendConflictError, type RuntimeStore } from '@livecourse/storage';
import type { RuntimeRecord, RuntimeSession } from '@livecourse/dsl';

import { evidenceRecordSchema, type EvidenceRecord } from '@/lib/livecourse/domain';
import { getLearnerKey } from '@/lib/runtime/learner-key';
import { getRuntimeStore } from '@/lib/runtime/store';

export const LIVECOURSE_EVIDENCE_KIND = 'livecourseEvidence';

interface EvidenceRepositoryDeps {
  store?: RuntimeStore;
  learnerId?: string;
  /** Optional for the generic evidence ledger; course-memory callers must provide it. */
  courseId?: string;
  now?: () => string;
  /** Lifecycle guard checked before each potentially durable boundary. */
  assertActive?: () => void;
}

function sessionId(stageId: string, learnerId: string): string {
  return `livecourse-evidence:${stageId}:${learnerId}`;
}

function matchesPartition(
  session: RuntimeSession,
  id: string,
  stageId: string,
  learnerId: string,
): boolean {
  return (
    session.id === id &&
    session.kind === LIVECOURSE_EVIDENCE_KIND &&
    session.stageId === stageId &&
    session.learnerKey === learnerId
  );
}

async function createOrGetSession(
  store: RuntimeStore,
  stageId: string,
  learnerId: string,
  now: string,
  assertActive?: () => void,
): Promise<RuntimeSession> {
  assertActive?.();
  const id = sessionId(stageId, learnerId);
  const existing = await store.getSession(id);
  assertActive?.();
  if (existing) {
    if (!matchesPartition(existing, id, stageId, learnerId)) {
      throw new Error(`Evidence session ${JSON.stringify(id)} belongs to another partition`);
    }
    return existing;
  }

  try {
    assertActive?.();
    const created = await store.createSession({
      id,
      kind: LIVECOURSE_EVIDENCE_KIND,
      stageId,
      learnerKey: learnerId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    assertActive?.();
    return created;
  } catch (error) {
    assertActive?.();
    const raced = await store.getSession(id).catch(() => undefined);
    assertActive?.();
    if (!raced || !matchesPartition(raced, id, stageId, learnerId)) throw error;
    return raced;
  }
}

function parseEvidenceRecords(records: readonly RuntimeRecord[]): EvidenceRecord[] {
  return records.map((record) => evidenceRecordSchema.parse(record.payload));
}

function sameEvidence(left: EvidenceRecord, right: EvidenceRecord): boolean {
  const { occurredAt: _leftOccurredAt, ...leftStable } = evidenceRecordSchema.parse(left);
  const { occurredAt: _rightOccurredAt, ...rightStable } = evidenceRecordSchema.parse(right);
  return JSON.stringify(leftStable) === JSON.stringify(rightStable);
}

function findIdempotentRecord(
  records: readonly EvidenceRecord[],
  candidate: EvidenceRecord,
): EvidenceRecord | undefined {
  const existing = records.find(
    (record) => record.id === candidate.id || record.idempotencyKey === candidate.idempotencyKey,
  );
  if (!existing) return undefined;
  if (!sameEvidence(existing, candidate)) {
    throw new Error(
      `Evidence idempotency conflict for ${JSON.stringify(candidate.idempotencyKey)}`,
    );
  }
  return existing;
}

export async function listEvidenceRecords(
  stageId: string,
  deps: EvidenceRepositoryDeps,
): Promise<EvidenceRecord[]> {
  deps.assertActive?.();
  const store = deps.store ?? getRuntimeStore();
  const learnerId = deps.learnerId ?? (await getLearnerKey());
  deps.assertActive?.();
  const sessions = (await store.listSessions(stageId, learnerId)).filter(
    (session) => session.kind === LIVECOURSE_EVIDENCE_KIND,
  );
  deps.assertActive?.();
  const records = await Promise.all(
    sessions.map(async (session) => {
      deps.assertActive?.();
      const rows = await store.listRecords(session.id);
      deps.assertActive?.();
      return rows;
    }),
  );
  deps.assertActive?.();
  return records
    .flatMap(parseEvidenceRecords)
    .filter((record) => !deps.courseId || record.courseId === deps.courseId)
    .sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id),
    );
}

export async function appendEvidenceRecord(
  stageId: string,
  input: EvidenceRecord,
  deps: EvidenceRepositoryDeps = {},
): Promise<EvidenceRecord> {
  deps.assertActive?.();
  const candidate = evidenceRecordSchema.parse(input);
  const store = deps.store ?? getRuntimeStore();
  const learnerId = deps.learnerId ?? (await getLearnerKey());
  deps.assertActive?.();
  if (candidate.learnerId !== learnerId) {
    throw new Error('Evidence learnerId does not match the active learner partition');
  }
  if (deps.courseId && candidate.courseId !== deps.courseId) {
    throw new Error('Evidence courseId does not match the active course partition');
  }

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const session = await createOrGetSession(store, stageId, learnerId, now, deps.assertActive);
  deps.assertActive?.();

  for (let attempt = 0; attempt < 8; attempt += 1) {
    deps.assertActive?.();
    const runtimeRecords = await store.listRecords(session.id);
    deps.assertActive?.();
    const evidenceRecords = parseEvidenceRecords(runtimeRecords);
    const existing = findIdempotentRecord(evidenceRecords, candidate);
    if (existing) return existing;

    try {
      deps.assertActive?.();
      await store.appendRecord(
        {
          id: candidate.id,
          sessionId: session.id,
          sceneId: candidate.nodeId.replace(/^node:/, ''),
          createdAt: candidate.occurredAt,
          payload: candidate,
        },
        { expectedLastSeq: runtimeRecords.at(-1)?.seq ?? null },
      );
      deps.assertActive?.();
      return candidate;
    } catch (error) {
      if (error instanceof RuntimeAppendConflictError) continue;
      throw error;
    }
  }

  throw new Error('Evidence append did not converge after 8 compare-and-append retries');
}
