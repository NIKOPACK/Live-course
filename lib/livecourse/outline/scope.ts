/**
 * Deterministic scope check for the pre-lesson confirmation flow
 * (docs/spec/01-user-journeys.md J2.0b, docs/spec/04-detailed-design.md §7).
 *
 * The clarifier is intentionally allowed to degrade to `ready` when its model
 * call fails.  That fallback must not turn an obviously broad subject into an
 * unbounded lesson, so the preview uses this small, language-agnostic lexical
 * check as a second gate.  It is only a prompt to load the knowledge map; an
 * empty map still skips the picker and generation continues.
 */

const BROAD_SUBJECT_PATTERNS: readonly RegExp[] = [
  /高等数学|高数|数学/, // calculus/algebra requests commonly arrive as “数学”
  /物理|化学|生物|历史|地理|英语|编程|计算机科学|机器学习|数据科学|经济学|哲学|统计学/,
  /advanced\s+math(?:ematics)?|mathematics|physics|chemistry|biology|history|geography/,
  /english|program(?:ming)?|computer\s+science|machine\s+learning|data\s+science|economics|philosophy|statistics/,
];

/**
 * Return true when a requirement names a broad subject without a narrower
 * scope marker.  Explicitly scoped phrases (for example “链式法则” or
 * “limits and continuity”) are left to the clarifier and do not trigger an
 * extra picker.
 */
export function likelyNeedsKnowledgeMap(requirement: string): boolean {
  const normalized = requirement.trim().toLowerCase();
  if (!normalized) return false;
  return BROAD_SUBJECT_PATTERNS.some((pattern) => pattern.test(normalized));
}
