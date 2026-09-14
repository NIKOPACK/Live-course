/**
 * LiveCourse A6 — 三种记忆作用域的独立 schema
 * （docs/spec/04-detailed-design.md §6，docs/spec/05-development-plan.md A6）。
 *
 * 记忆不是一个全局自由文本池：W / C / L 三种作用域各有独立 schema、
 * 生命周期与 repository（见 repository.ts），namespace 只能经
 * namespaces.ts 构造。这里只定义数据结构；写入规则在 policy.ts，
 * 注入规则在 context.ts。
 *
 * 禁止项（schema 层面强制）：
 *   - `LearnerMemory` 是严格白名单，结构上不存在 courseId、课程名、
 *     知识点、题答、分数、掌握结论、课程摘要与原始对话字段；
 *   - 所有自由文本都有长度上限，bounded，不无界累积；
 *   - `CourseLearningMemory` 不复制证据流：只持有 intake、进度物化、
 *     误解 / 未解决问题与 evidence tail 水位（权威事实仍是
 *     evidence append stream 与 `CourseStateSnapshot`）。
 */
import { z } from 'zod';

import {
  identifierSchema,
  timestampSchema,
  type EvidenceRecord,
  type GoalState,
} from '@/lib/livecourse/domain';
import { LEARNER_MEMORY_PARTITION_STAGE_ID } from './namespaces';

// ──────────────────────────────────────────────
//  W — ClassroomWorkingMemory（scope: classroomSessionId）
// ──────────────────────────────────────────────

/** W 短摘要的硬上限：不无界累积，未归档临时内容不成为长期画像。 */
export const MAX_WORKING_SUMMARY_CHARS = 800;
/** W 插话 / 作答记录的硬上限。 */
export const MAX_WORKING_INTERRUPTIONS = 8;
export const MAX_WORKING_ANSWERS = 8;
/** W 临时教学调整的硬上限。 */
export const MAX_WORKING_ADJUSTMENTS = 8;

/** J3.2 插话：问题与有上限的处理状态，不含原始对话全文。 */
export const workingInterruptionSchema = z
  .object({
    id: identifierSchema,
    question: z.string().trim().min(1).max(500),
    resumeNodeId: identifierSchema,
    status: z.enum(['open', 'answered', 'archived']),
    occurredAt: timestampSchema,
  })
  .strict();

/** 当前题作答的短状态（提交中的事实；权威结果只走 evidence stream）。 */
export const workingAnswerStateSchema = z
  .object({
    nodeId: identifierSchema,
    checkpointId: identifierSchema.optional(),
    status: z.enum(['answering', 'submitted']),
    updatedAt: timestampSchema,
  })
  .strict();

/** 有上限的临时教学调整（未经协调器归档前只属于本 session）。 */
export const workingAdjustmentSchema = z
  .object({
    id: identifierSchema,
    note: z.string().trim().min(1).max(500),
    createdAt: timestampSchema,
  })
  .strict();

export const classroomWorkingMemorySchema = z
  .object({
    schemaVersion: z.literal(1),
    classroomSessionId: identifierSchema,
    stageId: identifierSchema,
    learnerId: identifierSchema,
    courseId: identifierSchema,
    lessonId: identifierSchema,
    /** 当前节点（null = 尚未进入任何节点）。 */
    currentNodeId: identifierSchema.nullable(),
    /** 插话冻结的恢复点（无插话时为 null）。 */
    resumeNodeId: identifierSchema.nullable(),
    interruptions: z.array(workingInterruptionSchema).max(MAX_WORKING_INTERRUPTIONS),
    currentAnswer: workingAnswerStateSchema.nullable(),
    transientAdjustments: z.array(workingAdjustmentSchema).max(MAX_WORKING_ADJUSTMENTS),
    /** 有上限短摘要；不是长期画像，session 销毁即消失。 */
    shortSummary: z.string().max(MAX_WORKING_SUMMARY_CHARS),
    updatedAt: timestampSchema,
  })
  .strict();

export type WorkingInterruption = z.infer<typeof workingInterruptionSchema>;
export type WorkingAnswerState = z.infer<typeof workingAnswerStateSchema>;
export type WorkingAdjustment = z.infer<typeof workingAdjustmentSchema>;
export type ClassroomWorkingMemory = z.infer<typeof classroomWorkingMemorySchema>;

// ──────────────────────────────────────────────
//  C — CourseLearningMemory（scope: learnerId + courseId）
// ──────────────────────────────────────────────

export const MAX_COURSE_UNRESOLVED = 20;
export const MAX_COURSE_MISCONCEPTIONS = 20;

/** 课前回答：生成开始时写入当前 C（J1；生成前不写，也不写 L）。 */
export const coursePreClassAnswerSchema = z
  .object({
    questionId: identifierSchema,
    answer: z.string().trim().min(1).max(1000),
    answeredAt: timestampSchema,
  })
  .strict();

/**
 * 课前 intake：需求、课前回答与最终范围。只在「开始生成」时随
 * `courseId` 创建写入当前 C；首页草稿 / 跳过 / 设置都不是学习事件。
 */
export const courseIntakeSchema = z
  .object({
    /** 学习者在首页提交的需求原文（有上限）。 */
    requirement: z.string().trim().min(1).max(2000),
    preClassAnswers: z.array(coursePreClassAnswerSchema).max(20),
    /** 最终确认的范围；跳过范围时写合理默认。 */
    finalScope: z.array(z.string().trim().min(1).max(500)).max(50),
    /** 学习者明确跳过了课前追问。 */
    skipped: z.boolean(),
    submittedAt: timestampSchema,
  })
  .strict();

/** 未解决问题：由协调器从 W 归档（插话 status=archived），可附节点引用。 */
export const courseUnresolvedQuestionSchema = z
  .object({
    id: identifierSchema,
    question: z.string().trim().min(1).max(500),
    nodeId: identifierSchema.optional(),
    sourceSessionId: identifierSchema,
    archivedAt: timestampSchema,
  })
  .strict();

/** 本课程内成立的误解（学习程度只属于本课程 / 主题，不跨课程）。 */
export const courseMisconceptionSchema = z
  .object({
    id: identifierSchema,
    note: z.string().trim().min(1).max(500),
    nodeId: identifierSchema.optional(),
    evidenceIds: z.array(identifierSchema).max(10),
    recordedAt: timestampSchema,
  })
  .strict();

/**
 * C 的 intake 部分（本模块持久化的唯一新事实）：需求 / 课前回答 / 范围 /
 * 误解 / 未解决问题。进度与证据不进这里——进度由 `CourseStateRepository`
 * 持久化，证据只走 evidence append stream；本模块通过
 * `loadCourseLearningMemory` 组合三者成完整 C 视图。
 */
export const courseMemoryRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    stageId: identifierSchema,
    learnerId: identifierSchema,
    courseId: identifierSchema,
    intake: courseIntakeSchema.optional(),
    misconceptions: z.array(courseMisconceptionSchema).max(MAX_COURSE_MISCONCEPTIONS),
    unresolvedQuestions: z.array(courseUnresolvedQuestionSchema).max(MAX_COURSE_UNRESOLVED),
    updatedAt: timestampSchema,
  })
  .strict();

/** 完整 C 视图（组合，非独立存储单元；证据与 GoalState 是投影 / 引用）。 */
export interface CourseLearningMemory {
  stageId: string;
  learnerId: string;
  courseId: string;
  intake?: z.infer<typeof courseIntakeSchema>;
  misconceptions: z.infer<typeof courseMisconceptionSchema>[];
  unresolvedQuestions: z.infer<typeof courseUnresolvedQuestionSchema>[];
  /** `CourseStateSnapshot` 的 completedNode / progress 物化（存在时）。 */
  progress?: { completedNodeIds: string[]; updatedAt: string };
  /** 恢复水位：组合视图生成时观察到的 evidence / snapshot 尾部。 */
  evidenceTailRevision: number;
  /** 由权威证据重算的 GoalState 投影（只读；本模块不写掌握结论）。 */
  goalStates: GoalState[];
  /** 物化引用：组合时观察到的证据记录（供教师上下文引用，不是第二事实源）。 */
  evidence: EvidenceRecord[];
}

export type CourseIntake = z.infer<typeof courseIntakeSchema>;
export type CoursePreClassAnswer = z.infer<typeof coursePreClassAnswerSchema>;
export type CourseUnresolvedQuestion = z.infer<typeof courseUnresolvedQuestionSchema>;
export type CourseMisconception = z.infer<typeof courseMisconceptionSchema>;
export type CourseMemoryRecord = z.infer<typeof courseMemoryRecordSchema>;

// ──────────────────────────────────────────────
//  L — LearnerMemory（scope: learnerId，严格白名单）
// ──────────────────────────────────────────────

/**
 * learner-only 白名单维度：语言、教学方法、节奏、互动 / 反馈方式、
 * 无障碍需要与稳定约束。除此之外的属性（课程名、知识点、题答、分数、
 * 掌握结论、课程摘要、原始对话）在结构上无处存放。
 */
export const LEARNER_MEMORY_DIMENSIONS = [
  'language',
  'teaching_method',
  'pace',
  'interaction_style',
  'feedback_style',
  'accessibility',
  'stable_constraint',
] as const;

export type LearnerMemoryDimension = (typeof LEARNER_MEMORY_DIMENSIONS)[number];

export const MAX_LEARNER_ENTRIES = 32;
export const MAX_LEARNER_VALUE_CHARS = 200;

/**
 * 推断条目来源。来源引用（candidate 侧）只用于 policy 判定，从不注入
 * prompt；写入 L 的条目只保留来源类型与计数。
 */
export const learnerMemorySourceTypeSchema = z.enum([
  /** 学习者明确表达且带「长期 / 通常」语义。 */
  'explicit_longterm',
  /** 跨多课独立证据达到 policy 门槛。 */
  'multi_course_evidence',
]);

export const learnerMemoryEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    id: identifierSchema,
    dimension: z.enum(LEARNER_MEMORY_DIMENSIONS),
    value: z.string().trim().min(1).max(MAX_LEARNER_VALUE_CHARS),
    sourceType: learnerMemorySourceTypeSchema,
    /** 支撑本条目的独立课程证据数（只存计数，不存课程标识）。 */
    supportingCourseCount: z.number().int().min(1),
    confidence: z.number().min(0).max(1),
    observedAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const learnerMemorySchema = z
  .object({
    schemaVersion: z.literal(1),
    stageId: identifierSchema,
    learnerId: identifierSchema,
    entries: z.array(learnerMemoryEntrySchema).max(MAX_LEARNER_ENTRIES),
    updatedAt: timestampSchema,
  })
  .strict();

export type LearnerMemorySourceType = z.infer<typeof learnerMemorySourceTypeSchema>;
export type LearnerMemoryEntry = z.infer<typeof learnerMemoryEntrySchema>;
export type LearnerMemory = z.infer<typeof learnerMemorySchema>;

// ──────────────────────────────────────────────
//  构造助手（纯函数）
// ──────────────────────────────────────────────

export function createEmptyWorkingMemory(input: {
  classroomSessionId: string;
  stageId: string;
  learnerId: string;
  courseId: string;
  lessonId: string;
  now: string;
}): ClassroomWorkingMemory {
  return classroomWorkingMemorySchema.parse({
    schemaVersion: 1,
    classroomSessionId: input.classroomSessionId,
    stageId: input.stageId,
    learnerId: input.learnerId,
    courseId: input.courseId,
    lessonId: input.lessonId,
    currentNodeId: null,
    resumeNodeId: null,
    interruptions: [],
    currentAnswer: null,
    transientAdjustments: [],
    shortSummary: '',
    updatedAt: input.now,
  });
}

export function createEmptyCourseMemoryRecord(input: {
  stageId: string;
  learnerId: string;
  courseId: string;
  now: string;
}): CourseMemoryRecord {
  return courseMemoryRecordSchema.parse({
    schemaVersion: 1,
    stageId: input.stageId,
    learnerId: input.learnerId,
    courseId: input.courseId,
    misconceptions: [],
    unresolvedQuestions: [],
    updatedAt: input.now,
  });
}

export function createEmptyLearnerMemory(input: {
  /**
   * Retained as an optional compatibility input for callers that construct a
   * memory alongside a classroom.  Learner memory is learner-only, so the
   * classroom stage is never persisted into the L payload.
   */
  stageId?: string;
  learnerId: string;
  now: string;
}): LearnerMemory {
  return learnerMemorySchema.parse({
    schemaVersion: 1,
    stageId: LEARNER_MEMORY_PARTITION_STAGE_ID,
    learnerId: input.learnerId,
    entries: [],
    updatedAt: input.now,
  });
}
