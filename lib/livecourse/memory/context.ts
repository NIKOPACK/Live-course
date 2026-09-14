/**
 * LiveCourse A6 — 教师上下文组装（有大小上限，固定优先级）
 * （docs/spec/04-detailed-design.md §6，03「记忆作用域」）。
 *
 * 注入教师 prompt 的记忆上下文由本模块统一组装，顺序固定：
 *
 *   本次明确表达 > 当前课堂工作记忆 (W) > 同课程记忆 (C) >
 *   跨课程学习者记忆 (L) > 默认值
 *
 * 低优先级不得覆盖高优先级；模型无权选择或提升数据作用域。读取矩阵：
 *
 *   - `in-class`：W + 当前 C + L；
 *   - `resume-same-course`：不读旧 session 临时项（无 W），读同一 C + L；
 *   - `new-course`：只读 L，且在注入前再次通过白名单 schema——其他
 *     课程的课程名、LessonPlan、知识点、题答、分数、掌握结论、课程
 *     摘要与原始对话在结构上无法进入（负向串课的代码边界）。
 *
 * 全部块都有字符上限，总量也有上限：记忆永远挤不掉 prompt 里的
 * 课程 / 任务 / 规则块（Letta bounded core 的思路，不引入其 runtime）。
 */
import {
  learnerMemoryEntrySchema,
  type ClassroomWorkingMemory,
  type CourseLearningMemory,
  type LearnerMemory,
  type LearnerMemoryEntry,
} from './schemas';

/** 检查投影给教师看的「会 / 不会」，不是掌握结论写入。 */
export function describeGoalMastery(
  status: 'not_started' | 'in_progress' | 'met' | 'needs_support',
): string {
  if (status === 'met') return '会';
  if (status === 'needs_support') return '不会';
  if (status === 'in_progress') return '进行中';
  return '尚未确认';
}

/** 各块与总量上限（字符）。 */
export const MAX_EXPLICIT_CHARS = 600;
export const MAX_WORKING_BLOCK_CHARS = 800;
export const MAX_COURSE_BLOCK_CHARS = 1200;
export const MAX_LEARNER_BLOCK_CHARS = 800;
export const MAX_TOTAL_CONTEXT_CHARS = 3000;

export type TeacherContextMode = 'in-class' | 'resume-same-course' | 'new-course';

/** 本次明确表达（J1/J3）：最高优先级，只影响本课。 */
export interface ExplicitExpression {
  label: string;
  value: string;
}

export interface TeacherContextInput {
  mode: TeacherContextMode;
  explicit?: readonly ExplicitExpression[];
  /** 仅 `in-class` 读取；其余模式忽略。 */
  workingMemory?: ClassroomWorkingMemory | undefined;
  /** 仅 `in-class` / `resume-same-course` 读取；`new-course` 忽略。 */
  courseMemory?: CourseLearningMemory | undefined;
  learnerMemory?: LearnerMemory | undefined;
  /** 默认值块（最低优先级）。 */
  defaults?: readonly ExplicitExpression[];
}

export interface TeacherContextBlock {
  priority: number;
  source: 'explicit' | 'working' | 'course' | 'learner' | 'defaults';
  text: string;
}

export interface TeacherContext {
  blocks: TeacherContextBlock[];
  /** 拼接后的有上限 prompt 文本。 */
  text: string;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function renderExplicit(explicit: readonly ExplicitExpression[]): string {
  const lines = explicit
    .map((item) => `- ${item.label}: ${truncate(item.value, 200)}`)
    .slice(0, 10);
  return lines.length ? lines.join('\n') : '';
}

function renderWorking(memory: ClassroomWorkingMemory): string {
  const lines: string[] = [];
  if (memory.currentNodeId) lines.push(`- Current node: ${memory.currentNodeId}`);
  if (memory.resumeNodeId) lines.push(`- Resume point: ${memory.resumeNodeId}`);
  for (const interruption of memory.interruptions.slice(-4)) {
    lines.push(`- Interruption (${interruption.status}): ${truncate(interruption.question, 150)}`);
  }
  if (memory.currentAnswer) {
    lines.push(`- Answer in progress at ${memory.currentAnswer.nodeId}`);
  }
  if (memory.shortSummary.trim()) {
    lines.push(`- Session summary: ${truncate(memory.shortSummary.trim(), 300)}`);
  }
  return lines.join('\n');
}

function renderCourse(memory: CourseLearningMemory): string {
  const lines: string[] = [];
  if (memory.progress) {
    lines.push(`- Completed nodes: ${memory.progress.completedNodeIds.length}`);
  }
  if (memory.intake) {
    lines.push(`- Requirement: ${truncate(memory.intake.requirement, 200)}`);
    if (memory.intake.finalScope.length) {
      lines.push(`- Scope: ${truncate(memory.intake.finalScope.join(' / '), 200)}`);
    }
  }
  for (const item of memory.misconceptions.slice(0, 5)) {
    lines.push(`- Misconception: ${truncate(item.note, 150)}`);
  }
  for (const item of memory.unresolvedQuestions.slice(0, 5)) {
    lines.push(`- Unresolved: ${truncate(item.question, 150)}`);
  }
  for (const state of memory.goalStates) {
    lines.push(`- Goal ${state.goalId}: ${describeGoalMastery(state.status)}`);
  }
  return lines.join('\n');
}

/**
 * L 注入前的再次白名单校验（读取矩阵「不同课新开」行）：任何不过
 * schema 的条目都被丢弃——即使存储行被写坏，课程内容也无法经此
 * 进入新课 prompt。
 */
export function filterInjectibleLearnerEntries(
  entries: readonly LearnerMemoryEntry[],
): LearnerMemoryEntry[] {
  return entries.filter((entry) => learnerMemoryEntrySchema.safeParse(entry).success);
}

function renderLearner(memory: LearnerMemory): string {
  const lines = filterInjectibleLearnerEntries(memory.entries)
    .slice(0, 10)
    .map((entry) => `- ${entry.dimension}: ${truncate(entry.value, 150)}`);
  return lines.join('\n');
}

/** 组装有上限的教师上下文（纯函数、确定性）。 */
export function buildTeacherContext(input: TeacherContextInput): TeacherContext {
  const blocks: TeacherContextBlock[] = [];
  const push = (
    priority: number,
    source: TeacherContextBlock['source'],
    text: string,
    max: number,
  ) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    blocks.push({ priority, source, text: truncate(trimmed, max) });
  };

  if (input.explicit?.length)
    push(0, 'explicit', renderExplicit(input.explicit), MAX_EXPLICIT_CHARS);
  if (input.mode === 'in-class' && input.workingMemory) {
    push(1, 'working', renderWorking(input.workingMemory), MAX_WORKING_BLOCK_CHARS);
  }
  if (input.mode !== 'new-course' && input.courseMemory) {
    push(2, 'course', renderCourse(input.courseMemory), MAX_COURSE_BLOCK_CHARS);
  }
  if (input.learnerMemory) {
    push(3, 'learner', renderLearner(input.learnerMemory), MAX_LEARNER_BLOCK_CHARS);
  }
  if (input.defaults?.length)
    push(4, 'defaults', renderExplicit(input.defaults), MAX_EXPLICIT_CHARS);

  blocks.sort((left, right) => left.priority - right.priority);
  const text = truncate(
    blocks.map((block) => `## ${block.source}\n${block.text}`).join('\n\n'),
    MAX_TOTAL_CONTEXT_CHARS,
  );
  return { blocks, text };
}
