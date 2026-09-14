/**
 * PBL v2 — course evidence ingestion boundary (P-005).
 *
 * The smallest integration that turns a completed `PBLEvaluation` plus an
 * explicit LiveCourse context into durable course evidence through the shared
 * `EvidenceIngestionService`. It owns NO PBL persistence or progress state:
 * it only (1) maps the already-pure PBL evaluation via
 * `mapPBLEvaluationToEvidenceInput`, then (2) routes the result through
 * `EvidenceIngestionService.ingestPBLEvaluation`.
 *
 * Hard rules inherited from the adapter and ingestion contract:
 *
 *   - The caller MUST supply explicit course/lesson/learner/goal/node/scope
 *     identity; a goal is never inferred from evaluation text.
 *   - A completed evaluation is required; invalid or incomplete context or
 *     evaluation fails loudly and nothing is written.
 *   - The mapped model score ALWAYS enters as `pending_review` — only the
 *     existing teacher-review flow can accept or reject it.
 *   - This file never reads or writes PBL project/progress state.
 */
import type { EvidenceRecord } from '@/lib/livecourse/domain';
import type { EvidenceIngestionService } from '@/lib/livecourse/evidence/ingestion';

import {
  mapPBLEvaluationToEvidenceInput,
  type PBLEvidenceContext,
} from './course-evidence-adapter';
import type { PBLEvaluation } from './types';

export { PBLEvidenceMappingError } from './course-evidence-adapter';
export type { PBLEvidenceContext } from './course-evidence-adapter';

/**
 * Ingests one completed PBL evaluation against explicit LiveCourse context via
 * the injected shared evidence boundary. The `EvidenceIngestionService` is
 * injected so callers (including tests) use a spy/in-memory ledger and the
 * shared pending_review semantics stay authoritative.
 */
export function ingestPBLCourseEvidence(
  service: EvidenceIngestionService,
  context: PBLEvidenceContext,
  evaluation: PBLEvaluation,
): Promise<EvidenceRecord> {
  const input = mapPBLEvaluationToEvidenceInput(context, evaluation);
  return service.ingestPBLEvaluation(input);
}
