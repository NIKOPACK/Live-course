/**
 * LiveCourse A6 产品闭环协调器（docs/spec/04 §6，05 A6）。
 *
 * 课堂控制器只在 `finalizeSession` / `saveAndLeaveSession` 调用这里：
 *   - 销毁 W 前把未解决问题与 needs_support 误解归档进当前 C；
 *   - 只从带「长期 / 通常」语义的明确表达收集 learner-only candidate，
 *     交给 policy 写 L。单次行为、本课方法偏好、课程内容都不进 L。
 *
 * 全部函数确定性、幂等：同一 interruption / goal / preference 重试不追加。
 */
import type { GoalState } from '@/lib/livecourse/domain';

import type { ExplicitExpression } from './context';
import {
  finalizeLearnerMemoryWithPolicy,
  learnerProfileCandidateSchema,
  type LearnerProfileCandidate,
  type PolicyDecision,
} from './policy';
import type { CourseMemoryRepository, LearnerMemoryRepository } from './repository';
import {
  MAX_COURSE_MISCONCEPTIONS,
  MAX_COURSE_UNRESOLVED,
  type ClassroomWorkingMemory,
  type CourseIntake,
  type CourseMemoryRecord,
  type LearnerMemoryDimension,
} from './schemas';

const LONG_TERM_MARKER = /长期|通常|一般都|一直以来|\balways\b|\busually\b|long[\s-]?term/i;

interface PreferencePattern {
  dimension: LearnerMemoryDimension;
  value: string;
  pattern: RegExp;
}

const PREFERENCE_PATTERNS: readonly PreferencePattern[] = [
  {
    dimension: 'teaching_method',
    value: '偏好图示',
    pattern: /图示|visual(?:s|\s+aids?)?|diagrams?/i,
  },
  {
    dimension: 'teaching_method',
    value: '先例后理',
    pattern: /先例后理|example[\s-]?first|先(?:听|看)?例子/i,
  },
  { dimension: 'teaching_method', value: '少公式', pattern: /少公式|few\s+formulas?/i },
  { dimension: 'pace', value: '慢一点', pattern: /慢一点|慢节奏|slow(?:er)?(?:\s+pace)?/i },
  { dimension: 'pace', value: '快一点', pattern: /快一点|快节奏|faster(?:\s+pace)?/i },
  { dimension: 'language', value: '中文', pattern: /中文|汉语|\bchinese\b/i },
  { dimension: 'language', value: 'English', pattern: /英文|英语|\benglish\b/i },
  {
    dimension: 'interaction_style',
    value: '多提问',
    pattern: /多提问|多互动|ask\s+(?:more\s+)?questions/i,
  },
  { dimension: 'feedback_style', value: '直接纠错', pattern: /直接纠错|直接指出错误/i },
  { dimension: 'accessibility', value: '需要字幕', pattern: /字幕|\bcaptions?\b|大字/i },
];

function candidateIdempotencyKey(dimension: string, value: string): string {
  return `${dimension}:${value}`;
}

/**
 * 从本课 intake 与本次明确表达收集 L candidate。
 * 没有「长期 / 通常」标记的偏好只影响本课，不进入返回列表。
 */
export function collectLearnerProfileCandidates(input: {
  intake?: CourseIntake;
  explicit?: readonly ExplicitExpression[];
  extra?: readonly LearnerProfileCandidate[];
  now: string;
}): LearnerProfileCandidate[] {
  const sources: string[] = [];
  if (input.intake?.requirement.trim()) sources.push(input.intake.requirement);
  for (const answer of input.intake?.preClassAnswers ?? []) {
    if (answer.answer.trim()) sources.push(answer.answer);
  }
  for (const expression of input.explicit ?? []) {
    const combined = `${expression.label} ${expression.value}`.trim();
    if (combined) sources.push(combined);
  }

  const collected = new Map<string, LearnerProfileCandidate>();
  for (const source of sources) {
    const clauses = source
      .split(/[。！？!?;；，,\n]+/)
      .map((clause) => clause.trim())
      .filter(Boolean);
    for (const clause of clauses) {
      if (!LONG_TERM_MARKER.test(clause)) continue;
      for (const pattern of PREFERENCE_PATTERNS) {
        if (!pattern.pattern.test(clause)) continue;
        const candidate = learnerProfileCandidateSchema.parse({
          dimension: pattern.dimension,
          value: pattern.value,
          source: { type: 'explicit', longTerm: true },
          confidence: 0.9,
          observedAt: input.now,
        });
        collected.set(candidateIdempotencyKey(candidate.dimension, candidate.value), candidate);
      }
    }
  }

  for (const extra of input.extra ?? []) {
    const parsed = learnerProfileCandidateSchema.safeParse(extra);
    if (!parsed.success) continue;
    collected.set(candidateIdempotencyKey(parsed.data.dimension, parsed.data.value), parsed.data);
  }

  return [...collected.values()].sort((left, right) =>
    left.dimension === right.dimension
      ? left.value.localeCompare(right.value)
      : left.dimension.localeCompare(right.dimension),
  );
}

function mergeUnresolved(
  current: CourseMemoryRecord['unresolvedQuestions'],
  incoming: CourseMemoryRecord['unresolvedQuestions'],
): CourseMemoryRecord['unresolvedQuestions'] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()]
    .sort(
      (left, right) =>
        left.archivedAt.localeCompare(right.archivedAt) || left.id.localeCompare(right.id),
    )
    .slice(-MAX_COURSE_UNRESOLVED);
}

function mergeMisconceptions(
  current: CourseMemoryRecord['misconceptions'],
  incoming: CourseMemoryRecord['misconceptions'],
): CourseMemoryRecord['misconceptions'] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()]
    .sort(
      (left, right) =>
        left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id),
    )
    .slice(-MAX_COURSE_MISCONCEPTIONS);
}

/** 未回答插话归档为 C 未解决问题；needs_support 目标归档为本课误解。 */
export function projectCourseArchive(input: {
  current: CourseMemoryRecord;
  workingMemory?: ClassroomWorkingMemory;
  goalStates?: readonly GoalState[];
  now: string;
}): CourseMemoryRecord {
  const unresolved = (input.workingMemory?.interruptions ?? [])
    .filter((item) => item.status === 'open')
    .map((item) => ({
      id: item.id,
      question: item.question,
      nodeId: item.resumeNodeId,
      sourceSessionId: input.workingMemory!.classroomSessionId,
      archivedAt: input.now,
    }));
  const misconceptions = (input.goalStates ?? [])
    .filter((state) => state.status === 'needs_support')
    .map((state) => ({
      id: `misconception:${state.goalId}`,
      note: `不会：${state.goalId}`,
      evidenceIds: [...state.evidenceIds].slice(0, 10),
      recordedAt: input.now,
    }));

  if (unresolved.length === 0 && misconceptions.length === 0) return input.current;

  return {
    ...input.current,
    unresolvedQuestions: mergeUnresolved(input.current.unresolvedQuestions, unresolved),
    misconceptions: mergeMisconceptions(input.current.misconceptions, misconceptions),
    updatedAt: input.now,
  };
}

/**
 * 销毁 W 前把可归档项写入当前 C。W 已空时是 no-op，不凭空创建课程记忆。
 * 重试按 interruption / goal id 去重。
 */
export async function archiveWorkingMemoryIntoCourse(options: {
  courseMemory: CourseMemoryRepository;
  workingMemory?: ClassroomWorkingMemory;
  goalStates?: readonly GoalState[];
  now?: string;
}): Promise<CourseMemoryRecord | undefined> {
  const hasOpenInterruptions = (options.workingMemory?.interruptions ?? []).some(
    (item) => item.status === 'open',
  );
  const hasNeedsSupport = (options.goalStates ?? []).some(
    (state) => state.status === 'needs_support',
  );
  if (!hasOpenInterruptions && !hasNeedsSupport) {
    return options.courseMemory.load();
  }

  const now = options.now ?? new Date().toISOString();
  return options.courseMemory.update((current) =>
    projectCourseArchive({
      current,
      workingMemory: options.workingMemory,
      goalStates: options.goalStates,
      now,
    }),
  );
}

/**
 * `finalizeSession` 的 A6 接缝：先归档 W→C，再按 intake 中的长期表达写 L。
 * 无合格 candidate 时 policy 仍是 no-op。
 */
export async function finalizeSessionLearnerMemory(options: {
  learnerMemory: LearnerMemoryRepository;
  courseMemory: CourseMemoryRepository;
  workingMemory?: ClassroomWorkingMemory;
  intake?: CourseIntake;
  explicit?: readonly ExplicitExpression[];
  extraCandidates?: readonly LearnerProfileCandidate[];
  goalStates?: readonly GoalState[];
  now?: () => string;
}): Promise<PolicyDecision[]> {
  const now = options.now ?? (() => new Date().toISOString());
  const timestamp = now();
  const archived = await archiveWorkingMemoryIntoCourse({
    courseMemory: options.courseMemory,
    workingMemory: options.workingMemory,
    goalStates: options.goalStates,
    now: timestamp,
  });
  const candidates = collectLearnerProfileCandidates({
    intake: options.intake ?? archived?.intake,
    explicit: options.explicit,
    extra: options.extraCandidates,
    now: timestamp,
  });
  return finalizeLearnerMemoryWithPolicy({
    learnerMemory: options.learnerMemory,
    candidates,
    now,
  });
}
