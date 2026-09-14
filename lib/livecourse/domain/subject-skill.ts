/**
 * LiveCourse — first declarative subject Skill contract (P-005).
 *
 * A checkpoint-evaluation Skill is declared by this module and validated at the
 * LiveCourse boundary. The declaration is intentionally data-only and fixed:
 *
 *   - a stable literal `id`
 *   - the exact supported `AssistantTaskKind` (`draft_feedback`)
 *   - a fixed tool allowlist (a Skill never receives arbitrary model/tool
 *     permissions)
 *   - required input-reference prefixes it must see on the task
 *   - the structured result / evidence shape it produces
 *
 * `validateSubjectSkillInvocation` is the ONLY boundary that turns an existing
 * `AssistantTask` into a validated `SubjectSkillInvocation`. It rejects a
 * nonmatching kind, a foreign course/lesson/node learner context, input
 * references missing the required prefixes, or a non-allowlisted tool BEFORE
 * any result handling can happen.
 *
 * Invariant: a Skill cannot call arbitrary models/tools, create a parallel task
 * lifecycle, or directly update GoalState/CoursePlan/classroom actions. It may
 * only be scheduled by reusing existing AssistantTask / gateway allowlist
 * semantics; the task's `courseId`, `lessonId`, `nodeId` and `inputRefs` are
 * the definitive source for Skill context and are treated as the only input
 * surface (free text is never parsed for goals/permissions).
 */
import type { AssistantTask, AssistantTaskKind } from './assistant-task';
import { identifierSchema } from './schemas';

/** Stable identifier for the first declarative checkpoint-evaluation Skill. */
export const SUBJECT_SKILL_ID = 'skill:checkpoint-evaluation:v1' as const;

/**
 * The single assistant task kind this Skill is allowed to be carried by.
 * Reuses an existing allowlisted kind so no new task kind is introduced.
 */
export const SUBJECT_SKILL_KIND = 'draft_feedback' satisfies AssistantTaskKind;

/**
 * Fixed tool allowlist for this Skill. A Skill never accepts an arbitrary tool
 * name; an invocation may only use (a subset of) these capabilities.
 */
export const SUBJECT_SKILL_TOOLS = ['read_checkpoint', 'grade_with_rubric'] as const;

export type SubjectSkillTool = (typeof SUBJECT_SKILL_TOOLS)[number];

/**
 * Required input-reference prefixes. A valid invocation must carry exactly the
 * references the Skill is allowed to read — one checkpoint and one rubric
 * reference — and no other reference forms.
 */
export const SUBJECT_SKILL_INPUT_PREFIXES = ['checkpoint:', 'rubric:'] as const;

/** The structured output/evidence shape a Skill produces. */
export interface SubjectSkillEvaluationResult {
  skillId: typeof SUBJECT_SKILL_ID;
  /** The checkpoint whose answer was evaluated. */
  checkpointId: string;
  /** The rubric the evaluation used. */
  rubricId: string;
  /** Normalized 0..1 score. Low-confidence model grading stays pending_review. */
  score: number;
  /** Bounded safe summary of the evaluation. */
  summary: string;
  /** ISO timestamp (optional override). */
  occurredAt?: string;
}

export class SubjectSkillValidationError extends Error {
  override readonly name = 'SubjectSkillValidationError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Explicit LiveCourse execution context an invocation must match and target.
 *
 * `stageId` is the persistence partition (the shared ingestion contract's
 * `EvidencePersistenceScope.stageId`) and is ALWAYS supplied explicitly and
 * carried through validation. It is never derived from `courseId`.
 */
export interface SubjectSkillExecutionContext {
  courseId: string;
  lessonId: string;
  learnerId: string;
  nodeId: string;
  goalId: string;
  /** The storage partition used unchanged as `scope.stageId`. */
  stageId: string;
}

/**
 * A validated Skill invocation. It is produced ONLY by
 * `validateSubjectSkillInvocation` and therefore already proves terminal task
 * success, the declared kind, an exact context match and a filtered tool set.
 */
export interface SubjectSkillInvocation {
  skillId: typeof SUBJECT_SKILL_ID;
  kind: typeof SUBJECT_SKILL_KIND;
  status: 'succeeded';
  taskId: string;
  taskVersion: number;
  courseId: string;
  lessonId: string;
  learnerId: string;
  nodeId: string;
  goalId: string;
  /** Validated/carried from context; used unchanged as the storage partition. */
  stageId: string;
  inputRefs: string[];
  tools: readonly SubjectSkillTool[];
}

function requireContext(value: string, label: string): string {
  const parsed = identifierSchema.safeParse(value);
  if (!parsed.success) {
    throw new SubjectSkillValidationError(
      'SUBJECT_SKILL_CONTEXT_REQUIRED',
      `${label} is required for a subject Skill invocation`,
    );
  }
  return parsed.data;
}

/**
 * Reject any tool that is not on the Skill's fixed allowlist.
 */
export function assertSubjectSkillToolAllowed(tool: string): asserts tool is SubjectSkillTool {
  if (!(SUBJECT_SKILL_TOOLS as readonly string[]).includes(tool)) {
    throw new SubjectSkillValidationError(
      'SUBJECT_SKILL_TOOL_NOT_ALLOWED',
      `subject Skill tool ${JSON.stringify(tool)} is not allowlisted`,
    );
  }
}

const DEFINITIVE_INPUT_PREFIXES = SUBJECT_SKILL_INPUT_PREFIXES as readonly string[];

function validateInputRefs(inputRefs: readonly string[]): string[] {
  if (!inputRefs.length) {
    throw new SubjectSkillValidationError(
      'SUBJECT_SKILL_INPUT_REFS_REQUIRED',
      'subject Skill invocation requires its declared input references',
    );
  }
  const hasCheckpoint = inputRefs.some((ref) => ref.startsWith('checkpoint:'));
  const hasRubric = inputRefs.some((ref) => ref.startsWith('rubric:'));
  if (!hasCheckpoint || !hasRubric) {
    throw new SubjectSkillValidationError(
      'SUBJECT_SKILL_INPUT_REFS_MISSING',
      'subject Skill invocation requires a checkpoint and a rubric input reference',
    );
  }
  for (const ref of inputRefs) {
    const matched = DEFINITIVE_INPUT_PREFIXES.some((prefix) => ref.startsWith(prefix));
    if (!matched) {
      throw new SubjectSkillValidationError(
        'SUBJECT_SKILL_INPUT_REFS_FOREIGN',
        `input reference ${JSON.stringify(ref)} is not on the Skill's allowed surface`,
      );
    }
  }
  return [...inputRefs];
}

/**
 * Validates an existing assistant task against the Skill declaration and an
 * explicit execution context. Rejects non-succeeded tasks, nonmatching kind,
 * foreign context, missing/foreign input references and non-allowlisted tools.
 */
export function validateSubjectSkillInvocation(
  task: AssistantTask,
  context: SubjectSkillExecutionContext,
  tools: readonly string[] = SUBJECT_SKILL_TOOLS,
): SubjectSkillInvocation {
  if (!task || task.kind !== SUBJECT_SKILL_KIND) {
    throw new SubjectSkillValidationError(
      'SUBJECT_SKILL_KIND_MISMATCH',
      `subject Skill requires task kind ${JSON.stringify(SUBJECT_SKILL_KIND)}`,
    );
  }
  if (task.status !== 'succeeded') {
    throw new SubjectSkillValidationError(
      'SUBJECT_SKILL_NOT_TERMINAL',
      `subject Skill requires a succeeded terminal task, not ${JSON.stringify(task.status)}`,
    );
  }
  if (
    task.courseId !== context.courseId ||
    task.lessonId !== context.lessonId ||
    task.nodeId !== context.nodeId
  ) {
    throw new SubjectSkillValidationError(
      'SUBJECT_SKILL_CONTEXT_MISMATCH',
      'assistant task context does not match the subject Skill execution context',
    );
  }

  const learnerId = requireContext(context.learnerId, 'context.learnerId');
  const goalId = requireContext(context.goalId, 'context.goalId');
  const stageId = requireContext(context.stageId, 'context.stageId');
  const inputRefs = validateInputRefs(task.inputRefs ?? []);

  const filtered: SubjectSkillTool[] = [];
  for (const tool of tools) {
    assertSubjectSkillToolAllowed(tool);
    if (!filtered.includes(tool)) filtered.push(tool);
  }
  if (filtered.length === 0) {
    throw new SubjectSkillValidationError(
      'SUBJECT_SKILL_TOOL_REQUIRED',
      'subject Skill invocation must declare at least one allowlisted tool',
    );
  }

  return {
    skillId: SUBJECT_SKILL_ID,
    kind: SUBJECT_SKILL_KIND,
    status: 'succeeded',
    taskId: requireContext(task.id, 'task.id'),
    taskVersion: task.version,
    courseId: context.courseId,
    lessonId: context.lessonId,
    learnerId,
    nodeId: context.nodeId,
    goalId,
    stageId,
    inputRefs,
    tools: Object.freeze([...filtered]) as readonly SubjectSkillTool[],
  };
}
