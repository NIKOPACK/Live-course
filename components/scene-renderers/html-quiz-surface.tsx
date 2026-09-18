'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QuizQuestion } from '@/lib/types/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useResolvedHtml } from '@/lib/livecourse/html/use-resolved-html';
import {
  htmlQuizAnswers,
  parseHtmlQuizAnswer,
  patchQuizHtml,
  type HtmlQuizState,
} from '@/lib/livecourse/html/quiz-bridge';

interface HtmlQuizSurfaceProps {
  readonly html: string;
  readonly title?: string;
  readonly stageId?: string;
  readonly questions?: QuizQuestion[];
  readonly state?: HtmlQuizState;
  readonly onAnswer?: (questionId: string, answer: string | string[]) => void;
  readonly onUseNative?: () => void;
}

const PREVIEW_STATE: HtmlQuizState = {
  phase: 'not_started',
  answers: {},
  results: [],
  readOnly: true,
};
const NO_QUESTIONS: QuizQuestion[] = [];

/** A local, sandboxed presentation surface, deliberately outside the iframe pool. */
export function HtmlQuizSurface({
  html: sourceHtml,
  title,
  stageId,
  questions = NO_QUESTIONS,
  state = PREVIEW_STATE,
  onAnswer,
  onUseNative,
}: HtmlQuizSurfaceProps) {
  const { t } = useI18n();
  const html = useResolvedHtml(sourceHtml, stageId);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [version, setVersion] = useState(0);
  const [failure, setFailure] = useState<{ html: string; message: string } | null>(null);
  const error = failure?.html === html ? failure.message : null;
  const srcDoc = useMemo(() => patchQuizHtml(html), [html]);
  const outgoingState = useMemo(
    () => ({
      ...state,
      answers: htmlQuizAnswers(questions, state.answers),
      results:
        state.phase === 'reviewing'
          ? state.results.map((result) => {
              const question = questions.find((candidate) => candidate.id === result.questionId);
              return { ...result, answer: question?.answer, analysis: question?.analysis };
            })
          : [],
    }),
    [state, questions],
  );

  const sendState = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { __livecourseQuiz: true, kind: 'state', state: outgoingState },
      '*',
    );
  }, [outgoingState]);

  const synchronize = useCallback(() => {
    sendState();
    iframeRef.current?.contentWindow?.postMessage({ __livecourseErrorReplayRequest: true }, '*');
  }, [sendState]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow ?? null;
      if (!frameWindow || event.source !== frameWindow) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      if (data.__livecourseQuiz === true && data.kind === 'ready') {
        synchronize();
        return;
      }
      if (
        data.__livecourseInteractive === true &&
        data.kind === 'runtime-error' &&
        data.errorKind !== 'resource' &&
        typeof data.message === 'string'
      ) {
        setFailure({ html, message: data.message.slice(0, 1200) });
        return;
      }
      const answer = parseHtmlQuizAnswer(
        event,
        frameWindow,
        questions,
        !state.readOnly && state.phase === 'answering' && !error && !!onAnswer,
      );
      if (answer) onAnswer?.(answer.questionId, answer.answer);
    };
    window.addEventListener('message', receive);
    synchronize();
    return () => window.removeEventListener('message', receive);
  }, [html, questions, state.readOnly, state.phase, error, onAnswer, synchronize, version]);

  const retry = () => {
    setFailure(null);
    setVersion((previous) => previous + 1);
  };

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col" data-html-surface>
      {questions.length > 0 && (state.readOnly || error) ? (
        <section
          className="sr-only"
          aria-label={t(state.phase === 'reviewing' ? 'quiz.quizReport' : 'quiz.title')}
          data-html-quiz-accessible-content
        >
          <ol>
            {questions.map((question) => {
              const result =
                state.phase === 'reviewing'
                  ? state.results.find((item) => item.questionId === question.id)
                  : undefined;
              const answer = state.answers[question.id];
              const answerText = Array.isArray(answer) ? answer.join(', ') : answer;
              return (
                <li key={question.id}>
                  <p>{question.question}</p>
                  {question.options?.length ? (
                    <ul>
                      {question.options.map((option) => (
                        <li key={option.value}>
                          {option.value}: {option.label}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {Object.hasOwn(state.answers, question.id) ? (
                    <p>
                      {t('quiz.yourAnswer')} {answerText || t('quiz.notAnswered')}
                    </p>
                  ) : null}
                  {result ? (
                    <>
                      <p>
                        {t(result.status === 'correct' ? 'quiz.correct' : 'quiz.incorrect')}
                        {' · '}
                        {result.earned} / {question.points ?? 1} {t('quiz.pointsSuffix')}
                      </p>
                      {question.answer?.length ? (
                        <p>
                          {t('quiz.correct')}: {question.answer.join(', ')}
                        </p>
                      ) : null}
                      {question.analysis ? (
                        <p>
                          {t('quiz.analysis')}
                          {question.analysis}
                        </p>
                      ) : null}
                      {result.aiComment ? (
                        <p>
                          {t('quiz.aiComment')}: {result.aiComment}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
      {error ? (
        <div role="alert" className="shrink-0 border-b bg-background p-3 text-sm">
          <p>
            {t(onUseNative ? 'htmlClassroom.quizRuntimeFailed' : 'htmlClassroom.runtimeFailed')}
          </p>
          <p className="max-h-16 overflow-auto break-words text-xs text-muted-foreground">
            {error}
          </p>
          <button type="button" onClick={retry} className="mr-4 underline">
            {t('htmlClassroom.retryPage')}
          </button>
          {onUseNative ? (
            <button type="button" onClick={onUseNative} className="underline">
              {t('htmlClassroom.basicQuestionView')}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="min-h-0 flex-1" inert={!!error || undefined}>
        <iframe
          key={`${html}\u0000${version}`}
          ref={iframeRef}
          srcDoc={srcDoc}
          onLoad={synchronize}
          onError={() =>
            setFailure({
              html,
              message: t('htmlClassroom.loadFailed'),
            })
          }
          title={title ?? t('quiz.title')}
          className="h-full w-full border-0"
          sandbox="allow-scripts"
          tabIndex={error ? -1 : undefined}
          style={{ pointerEvents: error ? 'none' : undefined }}
        />
      </div>
    </div>
  );
}
