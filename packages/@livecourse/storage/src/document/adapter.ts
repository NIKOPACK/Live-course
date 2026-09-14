/**
 * The aggregate ↔ normalized adapter: the one translation point between the
 * portable, embedded {@link LiveCourseDocument} and the per-entity rows a backend
 * stores. Pure and dependency-free (beyond DSL constants) so every backend —
 * browser today, HTTP later — shares the same split/reassemble semantics.
 *
 * The document is stamped at the root: the version envelope lives on the stage
 * (root) row, so a document has exactly one version, never a per-scene skew.
 */
import { DSL_VERSION, DSL_VERSION_KEY } from '@livecourse/dsl';
import type { Stage } from '@livecourse/dsl';
import type { LiveCourseDocument, SceneLike } from './types.js';

/** The stage (root) row: stage metadata plus the document's version stamp. */
export type StageRow<TStage extends Stage = Stage> = TStage & { [DSL_VERSION_KEY]: string };

/** The outline row: one opaque snapshot per stage, stored only when present. */
export interface OutlineRow {
  stageId: string;
  outline: unknown;
}

/** One optional course-plan metadata row per document. */
export interface CoursePlanRow {
  stageId: string;
  coursePlan: unknown;
}

/** The normalized rows a document splits into. */
export interface DocumentRows<TScene extends SceneLike, TStage extends Stage = Stage> {
  stageRow: StageRow<TStage>;
  sceneRows: TScene[];
  /** Present only when the document carries an outline. */
  outlineRow?: OutlineRow;
  /** Present only when the document carries course-plan metadata. */
  coursePlanRow?: CoursePlanRow;
}

/**
 * Split an embedded document into normalized rows, stamping the stage row at the
 * current DSL version (a fresh write is always current). The outline row is
 * emitted only when the document actually carries an outline — a document with
 * no outline produces no outline row (and the backend removes any stale one).
 */
export function splitDocument<TScene extends SceneLike, TStage extends Stage = Stage>(
  doc: LiveCourseDocument<TScene, TStage>,
): DocumentRows<TScene, TStage> {
  const stageRow: StageRow<TStage> = { ...doc.stage, [DSL_VERSION_KEY]: DSL_VERSION };
  const rows: DocumentRows<TScene, TStage> = { stageRow, sceneRows: doc.scenes };
  if (doc.outline !== undefined) {
    rows.outlineRow = { stageId: doc.stage.id, outline: doc.outline };
  }
  if (doc.coursePlan !== undefined) {
    rows.coursePlanRow = { stageId: doc.stage.id, coursePlan: doc.coursePlan };
  }
  return rows;
}

/**
 * Reassemble normalized rows into an embedded document — the inverse of
 * {@link splitDocument}. Scenes are returned sorted by `order`, the version is
 * lifted from the stage row to the document root (where the migrate() runner
 * reads it), and the outline is attached only when a row exists. This is the
 * pre-migration document; the backend runs `migrate()` on the result.
 */
export function reassembleDocument<TScene extends SceneLike, TStage extends Stage = Stage>(
  stageRow: StageRow<TStage>,
  sceneRows: TScene[],
  outlineRow?: OutlineRow,
  coursePlanRow?: CoursePlanRow,
): LiveCourseDocument<TScene, TStage> {
  const {
    [DSL_VERSION_KEY]: dslVersion,
    coursePlan: embeddedCoursePlan,
    ...stageFields
  } = stageRow as StageRow<TStage> & { coursePlan?: unknown };
  // StageRow adds exactly the version stamp; removing it restores TStage. TS
  // cannot prove that inverse for an arbitrary generic intersection.
  const stage = stageFields as unknown as TStage;
  const scenes = [...sceneRows].sort((a, b) => a.order - b.order);
  const doc: LiveCourseDocument<TScene, TStage> = { stage, scenes, dslVersion };
  if (outlineRow) doc.outline = outlineRow.outline;
  // The embedded form is accepted for compatibility with the first classroom
  // prototype. A normalized row wins when both are present.
  if (embeddedCoursePlan !== undefined) doc.coursePlan = embeddedCoursePlan;
  if (coursePlanRow) doc.coursePlan = coursePlanRow.coursePlan;
  return doc;
}
