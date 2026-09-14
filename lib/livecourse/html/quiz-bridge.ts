import type { QuizQuestion } from '@/lib/types/stage';
import type { QuestionResult } from '@/lib/quiz/grading';
import { patchHtmlForIframe } from '@/lib/utils/iframe';

export type HtmlQuizPhase =
  | 'not_started'
  | 'answering'
  | 'submitting'
  | 'grading'
  | 'grading_error'
  | 'reviewing';

export interface HtmlQuizState {
  phase: HtmlQuizPhase;
  answers: Record<string, string | string[]>;
  results: (QuestionResult & { answer?: string[]; analysis?: string })[];
  readOnly: boolean;
  totalPoints?: number;
  earnedScore?: number;
  teacherFeedbackPending?: boolean;
  gradingError?: string | null;
}

/** Normalize legacy native single-choice drafts for the HTML array contract. */
export function htmlQuizAnswers(
  questions: QuizQuestion[],
  answers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  return Object.fromEntries(
    questions.map((question) => {
      const value = answers[question.id];
      return [
        question.id,
        question.type === 'short_answer'
          ? typeof value === 'string'
            ? value
            : ''
          : Array.isArray(value)
            ? value
            : value
              ? [value]
              : [],
      ];
    }),
  );
}

/** This channel can only edit a known question's draft, never submit or grade. */
export function parseHtmlQuizAnswer(
  event: Pick<MessageEvent, 'source' | 'data'>,
  frameWindow: Window | null,
  questions: QuizQuestion[],
  acceptingAnswers: boolean,
): { questionId: string; answer: string | string[] } | null {
  if (!acceptingAnswers || !frameWindow || event.source !== frameWindow) return null;
  const data: unknown = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const message = data as Record<string, unknown>;
  if (
    message.__livecourseQuiz !== true ||
    message.kind !== 'answer' ||
    typeof message.questionId !== 'string'
  )
    return null;
  const question = questions.find((candidate) => candidate.id === message.questionId);
  if (!question) return null;
  const answer = message.answer;
  if (question.type === 'short_answer') {
    return typeof answer === 'string' ? { questionId: question.id, answer } : null;
  }
  if (
    !Array.isArray(answer) ||
    answer.length > (question.options?.length ?? 0) ||
    (question.type === 'single' && answer.length > 1) ||
    new Set(answer).size !== answer.length ||
    !Array.from(answer).every(
      (value) => typeof value === 'string' && question.options?.some((o) => o.value === value),
    )
  )
    return null;
  // The existing native view stores singles as strings. Keeping that shape
  // allows switching to its accessible alternative without losing selection.
  return {
    questionId: question.id,
    answer: question.type === 'single' ? (answer[0] ?? '') : [...answer],
  };
}

const QUIZ_BRIDGE = `<script data-livecourse-quiz-bridge>
(function () {
  var state = null;
  function publish() {
    if (!state) return;
    if (document.body) document.body.inert = state.readOnly || state.phase !== 'answering';
    window.dispatchEvent(new CustomEvent('livecourse:quiz-state', { detail: state }));
  }
  window.livecourseQuiz = Object.freeze({
    setAnswer: function (questionId, answer) {
      if (!state || state.readOnly || state.phase !== 'answering') return;
      window.parent.postMessage({
        __livecourseQuiz: true, kind: 'answer', questionId: questionId, answer: answer
      }, '*');
    }
  });
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.__livecourseQuiz !== true || data.kind !== 'state' || !data.state) return;
    state = data.state;
    publish();
  });
  document.addEventListener('DOMContentLoaded', function () {
    if (document.body) document.body.inert = !state || state.readOnly || state.phase !== 'answering';
    publish();
    window.parent.postMessage({ __livecourseQuiz: true, kind: 'ready' }, '*');
  });
})();
</script>`;

export function patchQuizHtml(html: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  const position = head ? head.index + head[0].length : 0;
  return patchHtmlForIframe(html.slice(0, position) + QUIZ_BRIDGE + html.slice(position));
}
