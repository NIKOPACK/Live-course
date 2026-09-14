/**
 * 大纲工作流共享契约（docs/spec/04-detailed-design.md §7，才新写 A3）。
 *
 * 三个 Agent：澄清 Clarifier、知识分解 Decomposer、审校 Reviewer。
 * 本文件只放跨前后端 / 跨 Agent 的类型，不含任何 LLM 调用。
 */

// ==================== 澄清 Clarifier ====================

export interface ClarifyOption {
  id: string;
  label: string;
  description?: string;
}

export interface ClarifyQuestion {
  id: string;
  question: string;
  options: ClarifyOption[];
  /** true 时学习者可以多选 */
  multiSelect: boolean;
}

export type ClarifyResult =
  | { status: 'ready'; reason?: string }
  | { status: 'needs_clarification'; questions: ClarifyQuestion[] };

/** 学习者对一道澄清题的作答。selectedOptionIds 为空即跳过该题。 */
export interface ClarifyAnswer {
  questionId: string;
  question: string;
  selectedOptionIds: string[];
  selectedLabels: string[];
}

// ==================== 知识分解 Decomposer ====================

export interface KnowledgeTopic {
  id: string;
  title: string;
  /** 一句话说明这个知识点讲什么 */
  summary?: string;
  /** 推荐默认勾选 */
  recommended: boolean;
  children?: KnowledgeTopic[];
}

export interface KnowledgeMap {
  /** 分解出的学科 / 主题名，如「高等数学（大一上）」 */
  subject: string;
  topics: KnowledgeTopic[];
}

// ==================== 审校 Reviewer ====================

export interface OutlineReviewIssue {
  sceneId?: string;
  problem: string;
  fix: string;
}

export interface OutlineReviewResult {
  pass: boolean;
  issues: OutlineReviewIssue[];
}

// ==================== Prompt 注入 ====================

/** 把澄清答案格式化为注入大纲 prompt 的文本块。无答案时返回空串。 */
export function formatClarificationForPrompt(answers: ClarifyAnswer[] | undefined): string {
  const answered = (answers ?? []).filter((a) => a.selectedLabels.length > 0);
  if (answered.length === 0) return '';
  const lines = answered.map((a) => `- ${a.question}: ${a.selectedLabels.join('、')}`);
  return `## Learner's Clarification Answers\n\n${lines.join('\n')}\n\nRespect these answers when deciding scope, difficulty, and goals.\n\n---`;
}

/** 把勾选的知识点格式化为注入大纲 prompt 的文本块。未勾选时返回空串。 */
export function formatSelectedTopicsForPrompt(selectedTitles: string[] | undefined): string {
  const titles = (selectedTitles ?? []).map((t) => t.trim()).filter(Boolean);
  if (titles.length === 0) return '';
  const lines = titles.map((t) => `- ${t}`);
  return `## Learner-Selected Scope\n\nThe learner explicitly chose to learn ONLY these topics:\n${lines.join('\n')}\n\nCover exactly this scope. Do not add topics outside the list; do not drop any listed topic.\n\n---`;
}
