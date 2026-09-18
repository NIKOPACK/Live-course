import type { QuizQuestion } from '@/lib/types/stage';
import type { QuestionResult } from '@/lib/quiz/grading';
import { patchHtmlForIframe } from '@/lib/utils/iframe';

export const HTML_QUIZ_STATE_CONTRACT = `For graded checkpoint HTML only, the host's
livecourse:quiz-state event detail has this exact shape: {phase, readOnly, answers, results}.
answers is an object keyed by question ID holding the LEARNER'S selections; choice answers are
string[] and short answers are strings. results is an ARRAY, NOT an object keyed by question ID.
Find a result with state.results.find(result => result.questionId === questionId).
Each result has {questionId, correct: true|false|null, status: "correct"|"incorrect", earned: number,
answer?: string[], analysis?: string, aiComment?: string}. result.answer is the CORRECT ANSWER KEY,
NOT the learner's selection. Restore inputs and show "your answer" ONLY from state.answers[questionId],
never from result.answer. Label the correct answer separately. Display host analysis/aiComment as text.
Do not invent feedback/message/explanation fields. Show feedback only when phase === "reviewing";
before submission results is empty. Enable inputs only when phase === "answering" && !state.readOnly.
Other phases are not_started, submitting, grading and grading_error; keep questions visible and
inputs locked in all of them. No host state means inputs stay disabled.`;

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

const QUIZ_SCROLL = `<style data-livecourse-quiz-scroll>
html { height: 100% !important; overflow-y: auto !important; overflow-x: hidden !important; }
body { height: auto !important; min-height: 100% !important; max-height: none !important; overflow: visible !important; }
</style>`;

const QUIZ_BRIDGE = `<script data-livecourse-quiz-bridge>
(function () {
  var state = null;
  function publish() {
    if (!state) return;
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
    publish();
    window.parent.postMessage({ __livecourseQuiz: true, kind: 'ready' }, '*');
  });
})();
</script>`;

export function patchQuizHtml(html: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  const position = head ? head.index + head[0].length : 0;
  return patchHtmlForIframe(
    html.slice(0, position) + QUIZ_SCROLL + QUIZ_BRIDGE + html.slice(position),
  );
}
