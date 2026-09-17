import type { EvidenceRecord, JsonValue, LessonNode, LessonPlan } from '@/lib/livecourse/domain';
import type { Scene } from '@/lib/types/stage';

export interface CheckpointFeedbackInput {
  nodeId: string;
  sceneId: string;
  attemptId: string;
  score: number;
  metadata?: Record<string, JsonValue>;
  hasModelGradedItems?: boolean;
}

export interface CheckpointTeacherPort {
  feedback(input: CheckpointFeedbackInput): Promise<void>;
  continueLesson(nodeId: string): Promise<void>;
}

/** Finishing an assessed checkpoint is not the same as accepting a mastery claim. */
export function isCompletedCheckpointEvidence(record: EvidenceRecord): boolean {
  return (
    record.source === 'checkpoint' &&
    record.score !== undefined &&
    (record.status === 'accepted' ||
      (record.status === 'pending_review' && record.evaluation?.method === 'model'))
  );
}

export function adjacentTeachingNode(
  plan: LessonPlan,
  nodeId: string,
  direction: -1 | 1,
): LessonNode | null {
  const nodes = [...plan.nodes].sort((left, right) => left.order - right.order);
  const index = nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) throw new Error(`Unknown teaching node: ${nodeId}`);
  return nodes[index + direction] ?? null;
}

export function nextTeachingNode(plan: LessonPlan, nodeId: string): LessonNode | null {
  return adjacentTeachingNode(plan, nodeId, 1);
}

export function checkpointFeedbackText(input: {
  result: CheckpointFeedbackInput;
  scene: Scene;
  language: string;
  passScore: number;
}): string {
  if (input.scene.id !== input.result.sceneId || input.scene.content.type !== 'quiz') {
    throw new Error('Checkpoint feedback requires the submitted quiz scene');
  }
  const chinese = input.language.startsWith('zh');
  const score = Math.round(input.result.score * 100);
  const passed = input.result.score >= input.passScore;
  const lines = [
    chinese
      ? `这次检查的${input.result.hasModelGradedItems ? '参考' : ''}得分是百分之${score}。${passed ? '这一部分做得不错。' : '我们再解释一下需要注意的地方。'}`
      : `Your ${input.result.hasModelGradedItems ? 'provisional ' : ''}checkpoint score is ${score} percent. ${passed ? 'Good work on this part.' : 'Let us go over the parts that need more explanation.'}`,
  ];
  const results = input.result.metadata?.results;
  if (Array.isArray(results)) {
    for (const result of results) {
      if (!result || typeof result !== 'object' || Array.isArray(result)) continue;
      if (result.correct === true) continue;
      const question = input.scene.content.questions.find((item) => item.id === result.questionId);
      if (!question) continue;
      const explanation =
        typeof result.aiComment === 'string' ? result.aiComment : question.analysis;
      lines.push(question.question);
      if (explanation?.trim()) {
        lines.push(explanation.trim());
      } else if (question.answer?.length) {
        const answer = question.answer
          .map(
            (value) => question.options?.find((option) => option.value === value)?.label ?? value,
          )
          .join(', ');
        lines.push(chinese ? `参考答案是：${answer}。` : `The reference answer is: ${answer}.`);
      }
    }
  }
  lines.push(
    chinese
      ? '有疑问可以继续问我，我们再继续上课。'
      : 'You can ask me about any doubts as we continue.',
  );
  return lines.join('\n');
}

/** Retain successful submissions; failed operations retry the same attempt. */
export function createCheckpointSubmissionCoordinator<T>() {
  const submissions = new Map<string, Promise<T>>();
  return (key: string, submit: () => Promise<T>): Promise<T> => {
    const existing = submissions.get(key);
    if (existing) return existing;
    const promise = Promise.resolve().then(submit);
    submissions.set(key, promise);
    void promise.catch(() => {
      if (submissions.get(key) === promise) submissions.delete(key);
    });
    return promise;
  };
}
