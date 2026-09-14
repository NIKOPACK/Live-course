/**
 * Runtime adapter for the unified evidence ingestion boundary.
 *
 * Bridges the pure `EvidenceIngestionService` to the existing
 * `@livecourse/storage`-backed runtime evidence repository. The repository
 * retains its idempotency and conflict semantics unchanged; this file only
 * narrows it to the `EvidenceLedgerPort` contract so every ingestion path
 * shares one persistence boundary.
 */
import type { RuntimeStore } from '@livecourse/storage';

import type { EvidenceRecord } from '@/lib/livecourse/domain';
import type {
  EvidenceLedgerPort,
  EvidencePersistenceScope,
} from '@/lib/livecourse/evidence/ingestion';
import { EvidenceIngestionService } from '@/lib/livecourse/evidence/ingestion';
import {
  appendEvidenceRecord,
  listEvidenceRecords,
} from '@/lib/livecourse/evidence/runtime-repository';

export interface RuntimeEvidenceLedgerOptions {
  store?: RuntimeStore;
  /** Reject a read/write that outlived its owning classroom lifecycle. */
  assertActive?: () => void;
}

/** Injected store keeps browser/PostgreSQL tests hermetic; the default store
 *  matches the existing runtime behaviour (the active runtime store). */
export function createRuntimeEvidenceLedger(
  options: RuntimeEvidenceLedgerOptions = {},
): EvidenceLedgerPort {
  return {
    async list(scope: EvidencePersistenceScope): Promise<EvidenceRecord[]> {
      options.assertActive?.();
      const records = await listEvidenceRecords(scope.stageId, {
        store: options.store,
        learnerId: scope.learnerId,
        courseId: scope.courseId,
        assertActive: options.assertActive,
      });
      options.assertActive?.();
      return records;
    },
    async write(scope, record) {
      options.assertActive?.();
      const persisted = await appendEvidenceRecord(scope.stageId, record, {
        store: options.store,
        learnerId: scope.learnerId,
        courseId: record.courseId,
        assertActive: options.assertActive,
      });
      options.assertActive?.();
      return persisted;
    },
  };
}

/** Default application-facing service backed by the active runtime store. */
export function createLiveCourseEvidenceService(
  options: RuntimeEvidenceLedgerOptions = {},
): EvidenceIngestionService {
  return new EvidenceIngestionService(createRuntimeEvidenceLedger(options));
}
