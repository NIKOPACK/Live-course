/**
 * LiveCourse A6 — 跨课程学习者记忆（L）的确定性白名单 policy
 * （docs/spec/04-detailed-design.md §6，05 A6）。
 *
 * 模型只产 candidate；只有本模块的确定性规则能决定写不写 L：
 *
 *   - dimension 必须在白名单（语言 / 教学方法 / 节奏 / 互动 / 反馈 /
 *     无障碍 / 稳定约束），其余一律拒写；
 *   - 明确表达必须带「长期 / 通常」语义（`longTerm: true`）才可写
 *     `explicit_longterm` 条目；不带长期语义的当前表达只在本课优先，
 *     永远不进 L（即使 finalization 也不写）；
 *   - 行为推断必须来自 ≥ `MULTI_COURSE_EVIDENCE_THRESHOLD` 门课程的
 *     相互独立证据才写 `multi_course_evidence` 条目——单次行为不能
 *     形成永久标签；
 *   - 冲突时不得静默覆盖：候选与既有同维度条目取值不同时，只有
 *     「明确长期表达」或「支撑课程数严格更多」的候选才能替换；
 *     其余冲突保留既有条目（`conflict-kept`），等待再次确认；
 *   - 来源引用（`sourceRefs`）只参与判定与审计决策输出，从不写入
 *     存储条目，也从不注入 prompt（条目只存 sourceType 与计数）。
 *
 * 全部函数纯、确定性：同一 (candidates, existing, now) 永远得到同一结果，
 * 这正是 `finalizeSession` 重试幂等的前提。
 */
import { z } from 'zod';

import { identifierSchema, timestampSchema } from '@/lib/livecourse/domain';
import {
  LEARNER_MEMORY_DIMENSIONS,
  learnerMemoryEntrySchema,
  MAX_LEARNER_ENTRIES,
  type LearnerMemory,
  type LearnerMemoryEntry,
} from './schemas';
import type { LearnerMemoryRepository } from './repository';

/** 行为推断写 L 所需的相互独立课程证据下限。 */
export const MULTI_COURSE_EVIDENCE_THRESHOLD = 2;

export const MAX_CANDIDATE_VALUE_CHARS = 200;
export const MAX_CANDIDATE_SOURCE_REFS = 8;

/**
 * 模型产出的 learner-profile candidate。`sourceRefs` 是不注入 prompt 的
 * 来源引用（如 evidence id / session id），只用于 policy 判定与审计。
 */
export const learnerProfileCandidateSchema = z
  .object({
    dimension: z.enum(LEARNER_MEMORY_DIMENSIONS),
    value: z.string().trim().min(1).max(MAX_CANDIDATE_VALUE_CHARS),
    source: z.discriminatedUnion('type', [
      z
        .object({
          /** 学习者本次明确表达。 */
          type: z.literal('explicit'),
          /** 表达明确带有「长期 / 通常」语义才可写 L。 */
          longTerm: z.boolean(),
        })
        .strict(),
      z
        .object({
          /** 行为推断：必须列出相互独立的课程证据数。 */
          type: z.literal('behavioral'),
          /** 支撑该推断的相互独立课程数（只存计数；课程标识不落 L）。 */
          independentCourseCount: z.number().int().min(1),
        })
        .strict(),
    ]),
    confidence: z.number().min(0).max(1),
    observedAt: timestampSchema,
    sourceRefs: z.array(identifierSchema).max(MAX_CANDIDATE_SOURCE_REFS).optional(),
  })
  .strict();

export type LearnerProfileCandidate = z.infer<typeof learnerProfileCandidateSchema>;

export type PolicyDecisionKind =
  | 'write'
  | 'update'
  | 'skip-not-whitelisted'
  | 'skip-not-longterm'
  | 'skip-insufficient-evidence'
  | 'conflict-kept';

export interface PolicyDecision {
  candidate: LearnerProfileCandidate;
  decision: PolicyDecisionKind;
  /** 写入 / 更新时的目标条目（尚未打 updatedAt）。 */
  entry?: Omit<LearnerMemoryEntry, 'updatedAt'>;
  reason: string;
}

/** 条目的确定性 id：同一 (dimension, value) 永远同 id，重试天然幂等。 */
export function learnerMemoryEntryId(dimension: string, value: string): string {
  // FNV-1a 32bit：确定性、无碰撞诉求之外（同维度同值同 id 即可）。
  let hash = 0x811c9dc5;
  const text = `${dimension}${value}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `learner-entry:${(hash >>> 0).toString(36)}`;
}

function candidateSourceType(
  candidate: LearnerProfileCandidate,
): 'explicit_longterm' | 'multi_course_evidence' | undefined {
  if (candidate.source.type === 'explicit') {
    return candidate.source.longTerm ? 'explicit_longterm' : undefined;
  }
  return candidate.source.independentCourseCount >= MULTI_COURSE_EVIDENCE_THRESHOLD
    ? 'multi_course_evidence'
    : undefined;
}

/** 单个 candidate 的判定（纯函数）。 */
export function evaluateCandidate(
  candidate: LearnerProfileCandidate,
  existing: readonly LearnerMemoryEntry[],
): PolicyDecision {
  const parsed = learnerProfileCandidateSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      candidate,
      decision: 'skip-not-whitelisted',
      reason: 'Candidate failed the learner-memory whitelist schema',
    };
  }

  if (candidate.source.type === 'explicit' && !candidate.source.longTerm) {
    return {
      candidate,
      decision: 'skip-not-longterm',
      reason:
        'Explicit preference without long-term semantics only takes priority in the current course; it is never written to cross-course learner memory',
    };
  }
  if (
    candidate.source.type === 'behavioral' &&
    candidate.source.independentCourseCount < MULTI_COURSE_EVIDENCE_THRESHOLD
  ) {
    return {
      candidate,
      decision: 'skip-insufficient-evidence',
      reason: `Behavioral inference needs evidence from at least ${MULTI_COURSE_EVIDENCE_THRESHOLD} independent courses; a single behavior cannot become a permanent label`,
    };
  }

  const sourceType = candidateSourceType(candidate);
  if (!sourceType) {
    return { candidate, decision: 'skip-insufficient-evidence', reason: 'Unqualified source' };
  }

  const supportingCourseCount =
    candidate.source.type === 'behavioral' ? candidate.source.independentCourseCount : 1;
  const entry: Omit<LearnerMemoryEntry, 'updatedAt'> = {
    schemaVersion: 1,
    id: learnerMemoryEntryId(candidate.dimension, candidate.value),
    dimension: candidate.dimension,
    value: candidate.value,
    sourceType,
    supportingCourseCount,
    confidence: candidate.confidence,
    observedAt: candidate.observedAt,
  };

  const sameValue = existing.find((item) => item.id === entry.id);
  if (sameValue) {
    // 同维度同值：合并不冲突，刷新来源 / 置信度 / 证据计数（取更大者，
    // 单调不退化——单次矛盾行为不能拉低稳定偏好）。
    return {
      candidate,
      decision: 'update',
      entry: {
        ...entry,
        supportingCourseCount: Math.max(sameValue.supportingCourseCount, supportingCourseCount),
        confidence: Math.max(sameValue.confidence, candidate.confidence),
        observedAt:
          sameValue.observedAt < candidate.observedAt ? sameValue.observedAt : candidate.observedAt,
      },
      reason: 'Same value already present; refreshing provenance monotonically',
    };
  }

  const conflict = existing.find(
    (item) => item.dimension === candidate.dimension && item.value !== candidate.value,
  );
  if (conflict) {
    const mayReplace =
      sourceType === 'explicit_longterm' || supportingCourseCount > conflict.supportingCourseCount;
    if (!mayReplace) {
      return {
        candidate,
        decision: 'conflict-kept',
        reason:
          'Conflicts with an existing stable preference and does not meet a strictly higher bar; the existing entry is kept and the conflict waits for re-confirmation',
      };
    }
    return {
      candidate,
      decision: 'write',
      entry,
      reason:
        sourceType === 'explicit_longterm'
          ? 'Explicit long-term preference replaces the conflicting entry (the learner changed their mind explicitly)'
          : 'Behavioral evidence from strictly more independent courses replaces the conflicting entry',
    };
  }

  return { candidate, decision: 'write', entry, reason: 'Qualified new entry' };
}

export function evaluateCandidates(
  candidates: readonly LearnerProfileCandidate[],
  existing: readonly LearnerMemoryEntry[],
): PolicyDecision[] {
  // 逐个判定，已接受的写入参与后续候选的冲突视图（同批内也保持确定性）。
  const working = [...existing];
  const decisions: PolicyDecision[] = [];
  for (const candidate of candidates) {
    const decision = evaluateCandidate(candidate, working);
    decisions.push(decision);
    if ((decision.decision === 'write' || decision.decision === 'update') && decision.entry) {
      const index = working.findIndex((item) => item.dimension === decision.entry!.dimension);
      if (index >= 0) working.splice(index, 1);
      working.push({ ...decision.entry, updatedAt: candidate.observedAt });
    }
  }
  return decisions;
}

/** 应用决策产生新的条目集（纯函数；冲突被替换时移除旧条目）。 */
export function applyPolicyDecisions(
  memory: LearnerMemory,
  decisions: readonly PolicyDecision[],
  now: string,
): LearnerMemory {
  const entries = new Map(memory.entries.map((entry) => [entry.id, entry]));
  for (const decision of decisions) {
    if ((decision.decision !== 'write' && decision.decision !== 'update') || !decision.entry) {
      continue;
    }
    // 同维度冲突替换：移除同维度其他取值的旧条目。
    for (const [id, entry] of entries) {
      if (entry.dimension === decision.entry.dimension && entry.value !== decision.entry.value) {
        entries.delete(id);
      }
    }
    entries.set(decision.entry.id, { ...decision.entry, updatedAt: now });
  }
  const next = [...entries.values()]
    // 稳定排序：dimension → id，保证同一输入永远同一存储内容。
    .sort((left, right) =>
      left.dimension === right.dimension
        ? left.id.localeCompare(right.id)
        : left.dimension.localeCompare(right.dimension),
    )
    .slice(0, MAX_LEARNER_ENTRIES)
    .map((entry) => learnerMemoryEntrySchema.parse(entry));
  return { ...memory, entries: next, updatedAt: now };
}

/**
 * `finalizeSession` 的 L 写入接缝实现：归档 C 成功后、销毁 W 前由控制器
 * 调用。无候选时是纯 no-op（绝不假写 L）。任何存储失败向上抛——
 * finalize 整体失败、停在 finalizing、保留 W，可重试且结果一致。
 */
export async function finalizeLearnerMemoryWithPolicy(options: {
  learnerMemory: LearnerMemoryRepository;
  candidates: readonly LearnerProfileCandidate[];
  now?: () => string;
}): Promise<PolicyDecision[]> {
  if (options.candidates.length === 0) return [];
  const now = options.now ?? (() => new Date().toISOString());
  const current = await options.learnerMemory.load();
  const decisions = evaluateCandidates(options.candidates, current?.entries ?? []);
  const writable = decisions.some(
    (decision) => decision.decision === 'write' || decision.decision === 'update',
  );
  if (!writable) return decisions;
  await options.learnerMemory.update((existing) =>
    applyPolicyDecisions(existing, decisions, now()),
  );
  return decisions;
}
