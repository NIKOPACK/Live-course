/**
 * A6 生成入口的记忆接缝。
 *
 * 生成预览是一个「新课」边界：课前确认只能读取 learner-only L；在
 * 真正开始生成时才把本次需求、回答与最终范围写入当前课程 C。这个模块
 * 把两件事集中起来，避免页面组件直接拼 namespace 或误调用 L 的写入
 * policy。
 */
import type { RuntimeStore } from '@livecourse/storage';

import type { ClarifyAnswer } from '@/lib/livecourse/outline/types';
import { buildTeacherContext, type ExplicitExpression, type TeacherContext } from './context';
import { createCourseMemoryRepository, createLearnerMemoryRepository } from './repository';
import {
  courseIntakeSchema,
  type CourseIntake,
  type CourseMemoryRecord,
  type LearnerMemory,
} from './schemas';
import type { UserRequirements } from '@/lib/types/generation';

/** 生成入口读取到的跨课程上下文；读取不存在时 `learnerMemory` 为 undefined。 */
export interface NewCourseMemoryContext {
  learnerMemory: LearnerMemory | undefined;
  teacherContext: TeacherContext;
}

/**
 * 仅读取 learner-only L 并组装新课上下文。
 *
 * `createLearnerMemoryRepository().load()` 不会创建 RuntimeStore session；
 * 因而即使 L 尚不存在，这个函数也不会产生一条空的 L 记录。任何真实
 * 存储错误都会向上抛出，不能用空画像静默掩盖持久化故障。
 */
export async function loadNewCourseMemoryContext(options: {
  store: RuntimeStore;
  stageId: string;
  learnerId: string;
  requirements?: Pick<UserRequirements, 'userNickname' | 'userBio'>;
}): Promise<NewCourseMemoryContext> {
  const learnerMemory = await createLearnerMemoryRepository({
    store: options.store,
    scope: { stageId: options.stageId, learnerId: options.learnerId },
  }).load();

  return {
    learnerMemory,
    teacherContext: buildTeacherContext({
      mode: 'new-course',
      explicit: explicitExpressionsFromRequirements(options.requirements),
      learnerMemory,
    }),
  };
}

/**
 * 从当前需求构造 C 的课前 intake。未显式勾选范围时以本次需求的 bounded
 * 文本作为合理默认范围；这让「跳过范围确认」仍留下可恢复、可审计的
 * 当前课程事实，而不会把空范围误读成“没有范围”。
 */
export function buildGenerationCourseIntake(options: {
  requirements: UserRequirements;
  skipped?: boolean;
  now: string;
}): CourseIntake {
  const requirement = options.requirements.requirement.trim();
  const answeredAt = options.now;
  const preClassAnswers = (options.requirements.clarificationAnswers ?? [])
    .filter(
      (answer): answer is ClarifyAnswer =>
        !!answer &&
        typeof answer.questionId === 'string' &&
        answer.questionId.trim().length > 0 &&
        Array.isArray(answer.selectedLabels) &&
        answer.selectedLabels.some((label) => typeof label === 'string' && label.trim().length > 0),
    )
    .map((answer) => ({
      questionId: answer.questionId.trim(),
      answer: answer.selectedLabels
        .filter((label): label is string => typeof label === 'string')
        .map((label) => label.trim())
        .filter(Boolean)
        .join('、'),
      answeredAt,
    }))
    .filter((answer) => answer.answer.length > 0)
    .slice(0, 20);

  const selectedTopics = (options.requirements.selectedTopics ?? [])
    .filter((topic): topic is string => typeof topic === 'string')
    .map((topic) => topic.trim())
    .filter(Boolean)
    .slice(0, 50);
  const finalScope = selectedTopics.length > 0 ? selectedTopics : [requirement.slice(0, 500)];

  return courseIntakeSchema.parse({
    requirement,
    preClassAnswers,
    finalScope,
    skipped: options.skipped === true,
    submittedAt: options.now,
  });
}

/**
 * 在生成开始边界写当前课程 intake。相同 intake 的重试返回原记录，不会
 * 追加新的 C revision；需求或确认结果变化时才追加一条新的当前状态。
 */
export async function persistGenerationCourseIntake(options: {
  store: RuntimeStore;
  stageId: string;
  learnerId: string;
  courseId: string;
  intake: CourseIntake;
  now?: () => string;
}): Promise<CourseMemoryRecord> {
  const repository = createCourseMemoryRepository({
    store: options.store,
    scope: {
      stageId: options.stageId,
      learnerId: options.learnerId,
      courseId: options.courseId,
    },
    ...(options.now ? { now: options.now } : {}),
  });

  return repository.update((current) => {
    if (current.intake && sameCourseIntake(current.intake, options.intake)) return current;
    return { ...current, intake: options.intake };
  });
}

function sameCourseIntake(left: CourseIntake, right: CourseIntake): boolean {
  // `submittedAt` is intentionally ignored for retry comparison. Once an
  // intake is committed, a refresh/retry must retain its original timestamp
  // and avoid an unnecessary C append.
  const { submittedAt: _leftSubmittedAt, ...leftStable } = left;
  const { submittedAt: _rightSubmittedAt, ...rightStable } = right;
  return JSON.stringify(leftStable) === JSON.stringify(rightStable);
}

function explicitExpressionsFromRequirements(
  requirements: Pick<UserRequirements, 'userNickname' | 'userBio'> | undefined,
): ExplicitExpression[] {
  if (!requirements) return [];
  return [
    requirements.userNickname?.trim()
      ? { label: 'Learner name', value: requirements.userNickname.trim() }
      : undefined,
    requirements.userBio?.trim()
      ? { label: 'Learner background', value: requirements.userBio.trim() }
      : undefined,
  ].filter((item): item is ExplicitExpression => item !== undefined);
}
