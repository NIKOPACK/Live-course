'use client';

import { memo, useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  PieChart,
  CheckCircle2,
  XCircle,
  RotateCcw,
  ChevronRight,
  Check,
  BookOpenText,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { createLogger } from '@/lib/logger';

const log = createLogger('QuizView');
import type { QuizQuestion } from '@/lib/types/stage';
import { SpeechButton } from '@/components/audio/speech-button';
import { gradeChoiceQuestions, isShortAnswer, type QuestionResult } from '@/lib/quiz/grading';
import { renderQuizMathText } from '@/lib/quiz/math-text';
import { writeDraftRecovery } from '@/lib/quiz/persistence';
import {
  createQuizAttemptWriter,
  loadQuizAttemptState,
  QuizRetryProgressedError,
  type QuizAttemptWriter,
} from '@/lib/quiz/runtime';
import {
  createQuizViewLifetime,
  isQuizRuntimeReady,
  persistQuizReview,
  persistQuizRetry,
  persistQuizSubmission,
  quizViewStateFromAttempt,
  runQuizPersistenceTransition,
  type QuizRuntimeGate,
  type QuizViewLifetime,
} from '@/lib/quiz/view-state';
import { useLiveCourseSessionOptional } from '@/lib/livecourse/session/context';
import { ClassroomCaptionLayer } from '@/components/livecourse/LiveCaptionOverlay';
import { HtmlQuizSurface } from './html-quiz-surface';

// ─── Types ──────────────────────────────────────────────────────────────────

type Phase = 'not_started' | 'answering' | 'submitting' | 'grading' | 'grading_error' | 'reviewing';

interface QuizViewProps {
  readonly questions: QuizQuestion[];
  readonly sceneId: string;
  readonly stageId: string;
  readonly html?: string;
  /** Replay renders the question surface without creating or mutating an attempt. */
  readonly presentationOnly?: boolean;
  /** Overlay captions on the page surface so host Start/Submit stay clickable. */
  readonly showCaptions?: boolean;
}

const QuizMathText = memo(function QuizMathText({
  text,
  className,
  allowDisplayMode = false,
}: {
  text: string;
  className?: string;
  allowDisplayMode?: boolean;
}) {
  const segments = useMemo(() => renderQuizMathText(text), [text]);
  if (segments.length === 1 && segments[0].type === 'text') {
    return <span className={className}>{segments[0].value}</span>;
  }

  return (
    <span className={className}>
      {segments.map((segment, index) => {
        if (segment.type === 'text') {
          return <span key={index}>{segment.value}</span>;
        }

        return (
          <span
            key={index}
            className={cn(
              allowDisplayMode && segment.displayMode
                ? 'block my-1 overflow-x-auto [&_.katex-display]:!my-0'
                : 'inline-block align-baseline [&_.katex-display]:!my-0',
            )}
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        );
      })}
    </span>
  );
});

interface QuizGradeApiResponse {
  success: true;
  score: number;
  comment: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseQuizGradeApiResponse(value: unknown, points: number): QuizGradeApiResponse | null {
  if (
    !isRecord(value) ||
    value.success !== true ||
    typeof value.score !== 'number' ||
    !Number.isInteger(value.score) ||
    value.score < 0 ||
    value.score > points ||
    typeof value.comment !== 'string' ||
    value.comment.trim().length === 0
  ) {
    return null;
  }

  return {
    success: true,
    score: value.score,
    comment: value.comment.trim(),
  };
}

/** Call /api/quiz-grade for a single short-answer question. */
export async function gradeShortAnswerQuestion(
  q: QuizQuestion,
  userAnswer: string,
  language: string,
): Promise<QuestionResult> {
  const pts = q.points ?? 1;
  const modelConfig = getCurrentModelConfig();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-model': modelConfig.modelString,
    'x-api-key': modelConfig.apiKey,
  };
  if (modelConfig.baseUrl) headers['x-base-url'] = modelConfig.baseUrl;
  if (modelConfig.providerType) headers['x-provider-type'] = modelConfig.providerType;

  const res = await fetch('/api/quiz-grade', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      question: q.question,
      userAnswer,
      points: pts,
      commentPrompt: q.commentPrompt,
      language,
    }),
  });

  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = isRecord(payload) && typeof payload.error === 'string' ? payload.error : null;
    throw new Error(detail ?? `Quiz grading request failed (HTTP ${res.status})`);
  }

  const grade = parseQuizGradeApiResponse(payload, pts);
  if (!grade) throw new Error('Quiz grading service returned an invalid response');

  return {
    questionId: q.id,
    correct: grade.score >= pts * 0.8,
    status: grade.score >= pts * 0.8 ? 'correct' : 'incorrect',
    earned: grade.score,
    aiComment: grade.comment,
  };
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function QuizCover({
  questionCount,
  totalPoints,
  onStart,
  disabled = false,
  error,
}: {
  questionCount: number;
  totalPoints: number;
  onStart: () => void | Promise<void>;
  disabled?: boolean;
  error?: string | null;
}) {
  const { t } = useI18n();

  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-4 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-0 right-0 p-6 opacity-[0.03]">
        <PieChart className="w-52 h-52 text-violet-500" />
      </div>
      <div className="absolute bottom-0 left-0 p-6 opacity-[0.02]">
        <BookOpenText className="w-40 h-40 text-violet-500 rotate-12" />
      </div>

      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        className="w-16 h-16 bg-gradient-to-br from-violet-100 to-purple-50 dark:from-violet-900/50 dark:to-purple-900/30 rounded-2xl flex items-center justify-center shadow-lg shadow-violet-100 dark:shadow-violet-900/30 ring-1 ring-violet-200/50 dark:ring-violet-700/50"
      >
        <PieChart className="w-8 h-8 text-violet-500" />
      </motion.div>

      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1 }}
        className="text-center z-10"
      >
        <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100">{t('quiz.title')}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('quiz.subtitle')}</p>
      </motion.div>

      <motion.div
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="flex gap-5 text-sm z-10"
      >
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
          <div className="w-7 h-7 rounded-lg bg-violet-50 dark:bg-violet-900/30 flex items-center justify-center">
            <BookOpenText className="w-3.5 h-3.5 text-violet-500" />
          </div>
          <span>
            {questionCount} {t('quiz.questionsCount')}
          </span>
        </div>
        <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
          <div className="w-7 h-7 rounded-lg bg-violet-50 dark:bg-violet-900/30 flex items-center justify-center">
            <PieChart className="w-3.5 h-3.5 text-violet-500" />
          </div>
          <span>
            {t('quiz.totalPrefix')} {totalPoints} {t('quiz.pointsSuffix')}
          </span>
        </div>
      </motion.div>

      <motion.button
        initial={{ y: 10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.3 }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={onStart}
        disabled={disabled}
        className={cn(
          'relative z-20 mt-1 flex items-center gap-2 rounded-full bg-gradient-to-r from-violet-500 to-purple-500 px-8 py-2.5 font-medium text-white shadow-lg shadow-violet-200/50 transition-shadow hover:shadow-violet-300/50 dark:shadow-violet-900/50',
          disabled && 'cursor-wait opacity-70',
        )}
      >
        {t('quiz.startQuiz')}
        <ChevronRight className="w-4 h-4" />
      </motion.button>
      {error ? (
        <p
          role="alert"
          className="max-w-md px-6 text-center text-sm text-red-600 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SingleChoiceQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const isReview = !!result;

  return (
    <QuestionCard question={question} index={index} result={result}>
      <div className="grid gap-2">
        {question.options?.map((opt) => {
          const selected = value === opt.value;
          const isCorrectOpt = isReview && question.answer?.includes(opt.value);
          const isWrong = isReview && selected && result?.status === 'incorrect';

          return (
            <button
              key={opt.value}
              disabled={disabled}
              onClick={() => !disabled && onChange(opt.value)}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all text-sm',
                // Default state
                !isReview &&
                  !selected &&
                  'border-gray-200 dark:border-gray-600 hover:border-violet-200 dark:hover:border-violet-700 hover:bg-violet-50/50 dark:hover:bg-violet-900/30',
                !isReview &&
                  selected &&
                  'border-violet-400 bg-violet-50 dark:bg-violet-900/30 ring-1 ring-violet-200 dark:ring-violet-700',
                // Review states
                isReview &&
                  isCorrectOpt &&
                  'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30',
                isReview &&
                  isWrong &&
                  !isCorrectOpt &&
                  'border-red-300 bg-red-50 dark:bg-red-900/30',
                isReview &&
                  !isCorrectOpt &&
                  !selected &&
                  'border-gray-100 dark:border-gray-700 opacity-60',
                disabled && !isReview && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 transition-colors',
                  !isReview &&
                    !selected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
                  !isReview && selected && 'bg-violet-500 text-white',
                  isReview && isCorrectOpt && 'bg-emerald-500 text-white',
                  isReview && isWrong && !isCorrectOpt && 'bg-red-400 text-white',
                  isReview &&
                    !isCorrectOpt &&
                    !selected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500',
                )}
              >
                {opt.value}
              </span>
              <span
                className={cn(
                  'flex-1',
                  isReview && !isCorrectOpt && !selected && 'text-gray-400 dark:text-gray-500',
                )}
              >
                <QuizMathText text={opt.label} />
              </span>
              {isReview && isCorrectOpt && (
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
              )}
              {isReview && isWrong && !isCorrectOpt && (
                <XCircle className="w-5 h-5 text-red-400 shrink-0" />
              )}
            </button>
          );
        })}
      </div>
    </QuestionCard>
  );
}

function MultipleChoiceQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const isReview = !!result;
  const selected = value ?? [];

  const toggle = (optValue: string) => {
    if (disabled) return;
    if (selected.includes(optValue)) {
      onChange(selected.filter((v) => v !== optValue));
    } else {
      onChange([...selected, optValue]);
    }
  };

  const { t } = useI18n();

  return (
    <QuestionCard question={question} index={index} result={result}>
      {!isReview && (
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-2">
          {t('quiz.multipleChoiceHint')}
        </p>
      )}
      <div className="grid gap-2">
        {question.options?.map((opt) => {
          const isSelected = selected.includes(opt.value);
          const isCorrectOpt = isReview && question.answer?.includes(opt.value);
          const isWrong = isReview && isSelected && !isCorrectOpt;

          return (
            <button
              key={opt.value}
              disabled={disabled}
              onClick={() => toggle(opt.value)}
              className={cn(
                'flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all text-sm',
                !isReview &&
                  !isSelected &&
                  'border-gray-200 dark:border-gray-600 hover:border-violet-200 dark:hover:border-violet-700 hover:bg-violet-50/50 dark:hover:bg-violet-900/30',
                !isReview &&
                  isSelected &&
                  'border-violet-400 bg-violet-50 dark:bg-violet-900/30 ring-1 ring-violet-200 dark:ring-violet-700',
                isReview &&
                  isCorrectOpt &&
                  'border-emerald-400 bg-emerald-50 dark:bg-emerald-900/30',
                isReview && isWrong && 'border-red-300 bg-red-50 dark:bg-red-900/30',
                isReview &&
                  !isCorrectOpt &&
                  !isSelected &&
                  'border-gray-100 dark:border-gray-700 opacity-60',
                disabled && !isReview && 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 transition-colors',
                  !isReview &&
                    !isSelected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
                  !isReview && isSelected && 'bg-violet-500 text-white',
                  isReview && isCorrectOpt && 'bg-emerald-500 text-white',
                  isReview && isWrong && 'bg-red-400 text-white',
                  isReview &&
                    !isCorrectOpt &&
                    !isSelected &&
                    'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500',
                )}
              >
                {!isReview && isSelected ? <Check className="w-3.5 h-3.5" /> : opt.value}
              </span>
              <span
                className={cn(
                  'flex-1',
                  isReview && !isCorrectOpt && !isSelected && 'text-gray-400 dark:text-gray-500',
                )}
              >
                <QuizMathText text={opt.label} />
              </span>
              {isReview && isCorrectOpt && (
                <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
              )}
              {isReview && isWrong && <XCircle className="w-5 h-5 text-red-400 shrink-0" />}
            </button>
          );
        })}
      </div>
    </QuestionCard>
  );
}

function ShortAnswerQuestion({
  question,
  index,
  value,
  onChange,
  disabled,
  result,
}: {
  question: QuizQuestion;
  index: number;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  result?: QuestionResult;
}) {
  const isReview = !!result;
  const { t } = useI18n();
  // Ref to track latest value for voice transcription append
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  return (
    <QuestionCard question={question} index={index} result={result}>
      {!isReview ? (
        <div className="relative">
          <textarea
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder={t('quiz.inputPlaceholder')}
            className="w-full min-h-[100px] p-3 pb-10 rounded-xl border border-gray-200 dark:border-gray-600 text-sm resize-none focus:outline-none focus:border-violet-300 dark:focus:border-violet-600 focus:ring-2 focus:ring-violet-100 dark:focus:ring-violet-900/50 transition-all disabled:bg-gray-50 dark:disabled:bg-gray-800 disabled:text-gray-500 dark:bg-gray-800/50 dark:text-gray-200 dark:placeholder:text-gray-500"
          />
          <SpeechButton
            size="sm"
            disabled={disabled}
            className="absolute bottom-3 left-3"
            onTranscription={(text) => {
              const cur = valueRef.current ?? '';
              onChange(cur + (cur ? ' ' : '') + text);
            }}
          />
          <span className="absolute bottom-3 right-3 text-xs text-gray-300 dark:text-gray-600">
            {(value ?? '').length} {t('quiz.charCount')}
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="p-3 rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-300">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">{t('quiz.yourAnswer')}</p>
            {value ? (
              <QuizMathText text={value} />
            ) : (
              <span className="text-gray-400 dark:text-gray-500 italic">
                {t('quiz.notAnswered')}
              </span>
            )}
          </div>
          {result.aiComment && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-violet-50 dark:bg-violet-900/30 border border-violet-100 dark:border-violet-800">
              <Sparkles className="w-4 h-4 text-violet-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-violet-600 dark:text-violet-400 mb-0.5">
                  {t('quiz.aiComment')}
                </p>
                <p className="text-xs text-violet-600/80 dark:text-violet-400/80">
                  <QuizMathText text={result.aiComment} />
                </p>
              </div>
              <span className="ml-auto text-xs font-bold text-violet-600 dark:text-violet-400 shrink-0">
                {result.earned}/{question.points ?? 1}
                {t('quiz.pointsSuffix')}
              </span>
            </div>
          )}
        </div>
      )}
    </QuestionCard>
  );
}

function QuestionCard({
  question,
  index,
  result,
  children,
}: {
  question: QuizQuestion;
  index: number;
  result?: QuestionResult;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const isReview = !!result;
  const pts = question.points ?? 1;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.05 }}
      className={cn(
        'bg-white dark:bg-gray-800 rounded-2xl border p-5 relative overflow-hidden',
        !isReview && 'border-gray-150 dark:border-gray-700 shadow-sm',
        isReview &&
          result.status === 'correct' &&
          'border-emerald-200 dark:border-emerald-800 shadow-sm shadow-emerald-50 dark:shadow-emerald-900/20',
        isReview &&
          result.status === 'incorrect' &&
          'border-red-200 dark:border-red-800 shadow-sm shadow-red-50 dark:shadow-red-900/20',
      )}
    >
      {/* Left accent */}
      <div
        className={cn(
          'absolute left-0 top-0 bottom-0 w-1 rounded-l-2xl',
          !isReview && 'bg-violet-400',
          isReview && result.status === 'correct' && 'bg-emerald-400',
          isReview && result.status === 'incorrect' && 'bg-red-400',
        )}
      />

      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0',
              !isReview &&
                'bg-violet-100 dark:bg-violet-900/50 text-violet-600 dark:text-violet-400',
              isReview &&
                result.status === 'correct' &&
                'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400',
              isReview &&
                result.status === 'incorrect' &&
                'bg-red-100 dark:bg-red-900/50 text-red-600 dark:text-red-400',
            )}
          >
            {index + 1}
          </span>
          <div>
            <div className="text-sm font-medium text-gray-800 dark:text-gray-100 leading-relaxed">
              <QuizMathText text={question.question} allowDisplayMode />
            </div>
            <p className="text-xs text-gray-400 mt-0.5">
              {question.type === 'single'
                ? t('quiz.singleChoice')
                : question.type === 'multiple'
                  ? t('quiz.multipleChoice')
                  : t('quiz.shortAnswer')}
              {' · '}
              {pts} {t('quiz.pointsSuffix')}
            </p>
          </div>
        </div>
        {isReview && (
          <div className="shrink-0 ml-2">
            {result.status === 'correct' && <CheckCircle2 className="w-6 h-6 text-emerald-500" />}
            {result.status === 'incorrect' && <XCircle className="w-6 h-6 text-red-400" />}
          </div>
        )}
      </div>

      {/* Body */}
      {children}

      {/* Analysis (review only) */}
      {isReview && question.analysis && (
        <div className="mt-3 p-3 rounded-lg bg-blue-50/70 dark:bg-blue-900/30 border border-blue-100 dark:border-blue-800 text-xs text-blue-700 dark:text-blue-300 leading-relaxed">
          <span className="font-medium">{t('quiz.analysis')}</span>
          <QuizMathText text={question.analysis} allowDisplayMode />
        </div>
      )}
    </motion.div>
  );
}

function ScoreBanner({
  score,
  total,
  results,
}: {
  score: number;
  total: number;
  results: QuestionResult[];
}) {
  const { t } = useI18n();
  const pct = total > 0 ? Math.round((score / total) * 100) : 0;
  const correctCount = results.filter((r) => r.status === 'correct').length;
  const incorrectCount = results.filter((r) => r.status === 'incorrect').length;

  const color = pct >= 80 ? 'emerald' : pct >= 60 ? 'amber' : 'red';
  const colorMap = {
    emerald: {
      bg: 'from-emerald-500 to-teal-500',
      shadow: 'shadow-emerald-200/50 dark:shadow-emerald-900/50',
      ring: 'bg-emerald-400/30',
      text: t('quiz.excellent'),
    },
    amber: {
      bg: 'from-amber-500 to-yellow-500',
      shadow: 'shadow-amber-200/50 dark:shadow-amber-900/50',
      ring: 'bg-amber-400/30',
      text: t('quiz.keepGoing'),
    },
    red: {
      bg: 'from-red-500 to-rose-500',
      shadow: 'shadow-red-200/50 dark:shadow-red-900/50',
      ring: 'bg-red-400/30',
      text: t('quiz.needsReview'),
    },
  };
  const c = colorMap[color];

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className={cn('rounded-2xl p-6 bg-gradient-to-r text-white shadow-lg', c.bg, c.shadow)}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-white/80 text-sm font-medium">{c.text}</p>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-4xl font-black">{score}</span>
            <span className="text-white/60 text-lg">/ {total}</span>
          </div>
          <div className="flex gap-3 mt-3 text-xs">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> {correctCount} {t('quiz.correct')}
            </span>
            <span className="flex items-center gap-1">
              <XCircle className="w-3.5 h-3.5" /> {incorrectCount} {t('quiz.incorrect')}
            </span>
          </div>
        </div>

        {/* Percentage ring */}
        <div className="relative w-20 h-20">
          <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
            <circle
              cx="40"
              cy="40"
              r="34"
              fill="none"
              stroke="rgba(255,255,255,0.2)"
              strokeWidth="6"
            />
            <motion.circle
              cx="40"
              cy="40"
              r="34"
              fill="none"
              stroke="white"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 34}`}
              initial={{ strokeDashoffset: 2 * Math.PI * 34 }}
              animate={{ strokeDashoffset: 2 * Math.PI * 34 * (1 - pct / 100) }}
              transition={{ duration: 1, ease: 'easeOut', delay: 0.3 }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-lg font-black">{pct}%</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

function InteractiveQuizView({
  questions,
  sceneId,
  stageId,
  html,
  showCaptions = false,
}: QuizViewProps) {
  const { t, locale } = useI18n();
  const liveCourseSession = useLiveCourseSessionOptional();
  const openCheckpoint = liveCourseSession?.openCheckpoint;
  const recordQuizEvidence = liveCourseSession?.recordQuizEvidence;

  const [phase, setPhase] = useState<Phase>('not_started');
  const [useNative, setUseNative] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [results, setResults] = useState<QuestionResult[]>([]);
  const [runtimeGate, setRuntimeGate] = useState<QuizRuntimeGate>({ status: 'loading' });
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [openingCheckpoint, setOpeningCheckpoint] = useState(false);
  const [checkpointOpenError, setCheckpointOpenError] = useState<string | null>(null);
  const [gradingError, setGradingError] = useState<string | null>(null);
  const [teacherFeedbackPending, setTeacherFeedbackPending] = useState(false);
  const [evidenceSyncError, setEvidenceSyncError] = useState<string | null>(null);
  const [evidenceRetryVersion, setEvidenceRetryVersion] = useState(0);
  const [evidenceRetrying, setEvidenceRetrying] = useState(false);
  const viewLifetimeRef = useRef<QuizViewLifetime | null>(null);
  viewLifetimeRef.current ??= createQuizViewLifetime();
  const viewLifetime = viewLifetimeRef.current;
  const runtimeWriterRef = useRef<QuizAttemptWriter | null>(null);
  runtimeWriterRef.current ??= createQuizAttemptWriter({
    onError: (error) => log.warn('Failed to persist quiz runtime:', error),
  });
  const runtimeWriter = runtimeWriterRef.current;

  useEffect(() => {
    return () => {
      void runtimeWriter.flushDraft();
    };
  }, [runtimeWriter]);

  useEffect(() => {
    let cancelled = false;
    setRuntimeGate({ status: 'loading' });
    setRetrying(false);
    setGradingError(null);
    void loadQuizAttemptState({ stageId, sceneId })
      .then(({ attemptId: nextAttemptId, state }) => {
        if (cancelled) return;
        const next = quizViewStateFromAttempt(state);
        setPhase(next.phase);
        setAnswers(next.answers);
        setResults(next.results);
        setRuntimeGate({ status: 'ready', attemptId: nextAttemptId });
      })
      .catch((error) => {
        log.warn('Failed to hydrate quiz runtime:', error);
        if (!cancelled) setRuntimeGate({ status: 'error' });
      });
    return () => {
      cancelled = true;
      viewLifetime.invalidate();
      void runtimeWriter.flushDraft();
    };
  }, [hydrationVersion, runtimeWriter, sceneId, stageId, viewLifetime]);

  const attemptId = isQuizRuntimeReady(runtimeGate) ? runtimeGate.attemptId : null;

  const totalPoints = useMemo(
    () => questions.reduce((sum, q) => sum + (q.points ?? 1), 0),
    [questions],
  );

  const allAnswered = useMemo(() => {
    return questions.every((q) => {
      const a = answers[q.id];
      if (!a) return false;
      if (Array.isArray(a)) return a.length > 0;
      return (a as string).trim().length > 0;
    });
  }, [questions, answers]);

  const handleStart = useCallback(async () => {
    if (!attemptId || openingCheckpoint) return;
    setCheckpointOpenError(null);
    setOpeningCheckpoint(true);
    try {
      // Standalone quiz surfaces (for example a non-classroom preview) do not
      // own a teaching W and therefore have no checkpoint command to emit.
      // Inside a classroom, entering the answer phase is always gated by the
      // durable checkpoint.open transition.
      if (openCheckpoint) await openCheckpoint({ sceneId, attemptId });
      setPhase('answering');
    } catch (cause) {
      setCheckpointOpenError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOpeningCheckpoint(false);
    }
  }, [attemptId, openingCheckpoint, openCheckpoint, sceneId]);

  const handleSetAnswer = useCallback(
    (questionId: string, value: string | string[]) => {
      setAnswers((prev) => {
        const next = { ...prev, [questionId]: value };
        if (attemptId) {
          writeDraftRecovery(sceneId, attemptId, next);
          runtimeWriter.scheduleDraft({
            stageId,
            sceneId,
            attemptId,
            answers: next,
          });
        }
        return next;
      });
    },
    [attemptId, runtimeWriter, sceneId, stageId],
  );

  const handleSubmit = useCallback(async () => {
    if (!attemptId) return;
    setGradingError(null);
    setPhase('submitting');
    await runQuizPersistenceTransition(
      () => persistQuizSubmission({ stageId, sceneId, attemptId, answers }, runtimeWriter),
      viewLifetime,
      () => setPhase('grading'),
      (error) => {
        log.warn('Failed to persist quiz submission:', error);
        setRuntimeGate({ status: 'error' });
      },
    );
  }, [attemptId, answers, runtimeWriter, sceneId, stageId, viewLifetime]);

  // When entering grading phase, grade choice questions locally + call API for short-answer
  useEffect(() => {
    if (phase !== 'grading') return;
    let cancelled = false;

    (async () => {
      let choiceResults: QuestionResult[];
      const shortAnswerQs = questions.filter(isShortAnswer);
      let aiResults: QuestionResult[];
      try {
        choiceResults = gradeChoiceQuestions(questions, answers);
        aiResults = await Promise.all(
          shortAnswerQs.map((q) =>
            gradeShortAnswerQuestion(q, (answers[q.id] as string) ?? '', locale),
          ),
        );
      } catch (error) {
        log.error('[quiz-view] Grading failed:', error);
        if (!cancelled) {
          setGradingError(
            locale === 'zh-CN'
              ? '暂时无法评分，本次答题尚未评分。请重试。'
              : 'Grading is temporarily unavailable. This attempt has not been scored. Please retry.',
          );
          setPhase('grading_error');
        }
        return;
      }

      if (cancelled) return;

      // 3. Merge results in original question order
      const allResultsMap = new Map<string, QuestionResult>();
      for (const r of [...choiceResults, ...aiResults]) {
        allResultsMap.set(r.questionId, r);
      }
      const ordered = questions.map((q) => allResultsMap.get(q.id)!).filter(Boolean);

      if (!attemptId) {
        setRuntimeGate({ status: 'error' });
        return;
      }
      try {
        await persistQuizReview(
          { stageId, sceneId, attemptId, answers, results: ordered },
          runtimeWriter,
        );
      } catch (error) {
        log.warn('Failed to persist quiz review:', error);
        if (!cancelled) setRuntimeGate({ status: 'error' });
        return;
      }
      if (cancelled) return;
      setResults(ordered);
      setPhase('reviewing');
    })();

    return () => {
      cancelled = true;
    };
  }, [phase, questions, answers, locale, sceneId, stageId, attemptId, runtimeWriter]);

  const handleRetry = useCallback(async () => {
    if (!attemptId || retrying || teacherFeedbackPending || evidenceSyncError) return;
    setRetrying(true);
    runtimeWriter.cancelDraft();
    await runQuizPersistenceTransition(
      () => persistQuizRetry({ stageId, sceneId, attemptId }, runtimeWriter),
      viewLifetime,
      () => {
        setPhase('not_started');
        setAnswers({});
        setResults([]);
        setGradingError(null);
        setCheckpointOpenError(null);
        setEvidenceSyncError(null);
        // Do not leave the completed attempt id usable during the async
        // rollover hydration. The next start must use the newly-created retry
        // child, never reopen the parent attempt.
        setRuntimeGate({ status: 'loading' });
        // A retry is stored in a new RuntimeStore child session. Rehydrate the
        // gate before the next `checkpoint.open` so its idempotency key names
        // that child attempt rather than the completed parent attempt.
        setHydrationVersion((version) => version + 1);
        setRetrying(false);
      },
      (error) => {
        log.warn('Failed to persist quiz retry:', error);
        setRetrying(false);
        if (error instanceof QuizRetryProgressedError) {
          setHydrationVersion((version) => version + 1);
          return;
        }
        setRuntimeGate({ status: 'error' });
      },
    );
  }, [
    attemptId,
    retrying,
    teacherFeedbackPending,
    evidenceSyncError,
    runtimeWriter,
    sceneId,
    stageId,
    viewLifetime,
  ]);

  const earnedScore = useMemo(() => results.reduce((sum, r) => sum + r.earned, 0), [results]);

  useEffect(() => {
    if (phase !== 'reviewing' || !attemptId || results.length === 0 || !recordQuizEvidence) return;
    let cancelled = false;
    setTeacherFeedbackPending(true);
    const hasModelGradedItems = questions.some(isShortAnswer);
    void recordQuizEvidence({
      sceneId,
      attemptId,
      score: totalPoints > 0 ? earnedScore / totalPoints : 0,
      hasModelGradedItems,
      inputSummary: hasModelGradedItems
        ? `Quiz ${sceneId} contains ${questions.filter(isShortAnswer).length} model-graded item(s).`
        : undefined,
      metadata: {
        results: results.map((result) => ({
          questionId: result.questionId,
          correct: result.correct,
          status: result.status,
          earned: result.earned,
          ...(result.aiComment ? { aiComment: result.aiComment } : {}),
        })),
      },
    })
      .then(() => {
        if (!cancelled) {
          setEvidenceSyncError(null);
          setEvidenceRetrying(false);
          setTeacherFeedbackPending(false);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setEvidenceSyncError(error instanceof Error ? error.message : String(error));
          setEvidenceRetrying(false);
          setTeacherFeedbackPending(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    attemptId,
    earnedScore,
    evidenceRetryVersion,
    phase,
    questions,
    recordQuizEvidence,
    results,
    sceneId,
    totalPoints,
  ]);

  const retryEvidence = useCallback(() => {
    if (evidenceRetrying) return;
    setEvidenceRetrying(true);
    setEvidenceRetryVersion((version) => version + 1);
  }, [evidenceRetrying]);

  const resultMap = useMemo(() => {
    const map: Record<string, QuestionResult> = {};
    results.forEach((r) => {
      map[r.questionId] = r;
    });
    return map;
  }, [results]);

  const captions = showCaptions ? <ClassroomCaptionLayer /> : null;

  if (runtimeGate.status === 'error') {
    return (
      <div className="relative flex h-full w-full items-center justify-center bg-gray-50 dark:bg-gray-900">
        <button
          type="button"
          onClick={() => setHydrationVersion((version) => version + 1)}
          className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700"
        >
          <RotateCcw className="h-4 w-4" />
          {t('quiz.retry')}
        </button>
        {captions}
      </div>
    );
  }

  if (!isQuizRuntimeReady(runtimeGate)) {
    return (
      <div className="relative flex h-full w-full items-center justify-center bg-gray-50 dark:bg-gray-900">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        {captions}
      </div>
    );
  }

  if (html && !useNative) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <div className="relative min-h-0 flex-1" data-classroom-page-surface>
          <HtmlQuizSurface
            html={html}
            stageId={stageId}
            questions={questions}
            state={{
              phase,
              answers,
              results,
              readOnly: phase !== 'answering',
              totalPoints,
              earnedScore,
              teacherFeedbackPending,
              gradingError,
            }}
            onAnswer={handleSetAnswer}
            onUseNative={() => setUseNative(true)}
          />
          {captions}
        </div>
        <div
          data-quiz-host-chrome
          className="shrink-0 space-y-2 border-t bg-background px-4 py-3 text-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span role="status" aria-live="polite">
              {phase === 'not_started'
                ? `${questions.length} ${t('quiz.questionsCount')} · ${totalPoints} ${t('quiz.pointsSuffix')}`
                : phase === 'reviewing'
                  ? `${t('quiz.quizReport')} · ${earnedScore} / ${totalPoints}`
                  : phase === 'answering'
                    ? t('quiz.answering')
                    : phase === 'grading_error'
                      ? gradingError
                      : t('quiz.aiGrading')}
            </span>
            <div className="flex items-center gap-4">
              {phase === 'not_started' ? (
                <button
                  type="button"
                  onClick={() => void handleStart()}
                  disabled={openingCheckpoint}
                  className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
                >
                  {t('quiz.startQuiz')}
                </button>
              ) : phase === 'answering' || phase === 'grading_error' ? (
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={phase === 'answering' && !allAnswered}
                  className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
                >
                  {t(phase === 'grading_error' ? 'quiz.retry' : 'quiz.submitAnswers')}
                </button>
              ) : phase === 'reviewing' ? (
                <button
                  type="button"
                  onClick={() => void handleRetry()}
                  disabled={retrying || teacherFeedbackPending || !!evidenceSyncError}
                  className="underline disabled:opacity-50"
                >
                  {t('quiz.retry')}
                </button>
              ) : (
                <Loader2
                  role="status"
                  aria-label={t('quiz.aiGrading')}
                  className="h-5 w-5 animate-spin"
                />
              )}
            </div>
          </div>
          {checkpointOpenError ? <p role="alert">{checkpointOpenError}</p> : null}
          {phase === 'grading_error' ? <p role="alert">{gradingError}</p> : null}
          {teacherFeedbackPending ? (
            <p role="status" aria-busy="true">
              {t('livecourse.checkpointFeedback')}
            </p>
          ) : null}
          {evidenceSyncError ? (
            <div role="alert" className="flex items-center justify-between gap-3">
              <span>
                {t('livecourse.checkpointFeedbackFailed')}：{evidenceSyncError}
              </span>
              <button
                type="button"
                onClick={retryEvidence}
                disabled={evidenceRetrying}
                className="underline"
              >
                {t('quiz.retry')}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-gradient-to-b from-gray-50 to-white dark:from-gray-900 dark:to-gray-900">
      <AnimatePresence mode="wait">
        {phase === 'not_started' && (
          <motion.div
            key="cover"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1"
          >
            <QuizCover
              questionCount={questions.length}
              totalPoints={totalPoints}
              onStart={() => void handleStart()}
              disabled={openingCheckpoint}
              error={checkpointOpenError}
            />
          </motion.div>
        )}

        {phase === 'answering' && (
          <motion.div
            key="answering"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1 flex flex-col min-h-0"
          >
            {/* Header bar */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 backdrop-blur shrink-0">
              <div className="flex items-center gap-2">
                <PieChart className="w-4 h-4 text-violet-500" />
                <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                  {t('quiz.answering')}
                </span>
                <span className="text-xs text-gray-400 ml-1">
                  {
                    Object.keys(answers).filter((k) => {
                      const a = answers[k];
                      if (Array.isArray(a)) return a.length > 0;
                      return typeof a === 'string' && a.trim().length > 0;
                    }).length
                  }{' '}
                  / {questions.length}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!allAnswered}
                className={cn(
                  'px-4 py-1.5 rounded-lg text-xs font-medium transition-all',
                  allAnswered
                    ? 'bg-gradient-to-r from-violet-500 to-purple-500 text-white shadow-sm hover:shadow-md hover:shadow-violet-200/50 dark:hover:shadow-violet-900/50 active:scale-[0.97]'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed',
                )}
              >
                {t('quiz.submitAnswers')}
              </button>
            </div>

            {/* Questions */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {questions.map((q, i) => {
                if (q.type === 'single') {
                  return (
                    <SingleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string | undefined}
                      onChange={(v) => handleSetAnswer(q.id, v)}
                    />
                  );
                }
                if (q.type === 'multiple') {
                  return (
                    <MultipleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string[] | undefined}
                      onChange={(v) => handleSetAnswer(q.id, v)}
                    />
                  );
                }
                return (
                  <ShortAnswerQuestion
                    key={q.id}
                    question={q}
                    index={i}
                    value={answers[q.id] as string | undefined}
                    onChange={(v) => handleSetAnswer(q.id, v)}
                  />
                );
              })}
            </div>
          </motion.div>
        )}

        {(phase === 'submitting' || phase === 'grading') && (
          <motion.div
            key="grading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 flex flex-col items-center justify-center gap-5"
          >
            <motion.div
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }}
            >
              <Loader2 className="w-10 h-10 text-violet-500" />
            </motion.div>
            <div className="text-center">
              <p className="text-base font-semibold text-gray-700 dark:text-gray-200">
                {t('quiz.aiGrading')}
              </p>
              <p className="text-sm text-gray-400 mt-1">{t('quiz.aiGradingWait')}</p>
            </div>
            <div className="flex gap-1 mt-2">
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  className="w-2 h-2 rounded-full bg-violet-400"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{
                    repeat: Infinity,
                    duration: 1.2,
                    delay: i * 0.2,
                  }}
                />
              ))}
            </div>
          </motion.div>
        )}

        {phase === 'grading_error' && (
          <motion.div
            key="grading-error"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center"
            role="alert"
          >
            <XCircle className="h-10 w-10 text-red-500" />
            <p className="max-w-md text-sm text-red-700 dark:text-red-300">{gradingError}</p>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700"
            >
              <RotateCcw className="h-4 w-4" />
              {t('quiz.retry')}
            </button>
          </motion.div>
        )}

        {phase === 'reviewing' && (
          <motion.div
            key="reviewing"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex-1 flex flex-col min-h-0"
          >
            {/* Header bar */}
            <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 backdrop-blur shrink-0">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                  {t('quiz.quizReport')}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleRetry()}
                disabled={retrying || teacherFeedbackPending || !!evidenceSyncError}
                className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-violet-600 dark:hover:text-violet-400 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {t('quiz.retry')}
              </button>
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {teacherFeedbackPending ? (
                <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
                  {t('livecourse.checkpointFeedback')}
                </p>
              ) : null}
              {evidenceSyncError ? (
                <div
                  role="alert"
                  className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300"
                >
                  <span className="min-w-0 flex-1">
                    {t('livecourse.checkpointFeedbackFailed')}：{evidenceSyncError}
                  </span>
                  <button
                    type="button"
                    onClick={retryEvidence}
                    disabled={evidenceRetrying}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-red-300 px-2 py-1 text-xs font-medium hover:bg-red-100 disabled:cursor-wait disabled:opacity-60 dark:border-red-800 dark:hover:bg-red-900/40"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {t('quiz.retry')}
                  </button>
                </div>
              ) : null}
              <ScoreBanner score={earnedScore} total={totalPoints} results={results} />

              {questions.map((q, i) => {
                const r = resultMap[q.id];
                if (q.type === 'single') {
                  return (
                    <SingleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string | undefined}
                      onChange={() => {}}
                      disabled
                      result={r}
                    />
                  );
                }
                if (q.type === 'multiple') {
                  return (
                    <MultipleChoiceQuestion
                      key={q.id}
                      question={q}
                      index={i}
                      value={answers[q.id] as string[] | undefined}
                      onChange={() => {}}
                      disabled
                      result={r}
                    />
                  );
                }
                return (
                  <ShortAnswerQuestion
                    key={q.id}
                    question={q}
                    index={i}
                    value={answers[q.id] as string | undefined}
                    onChange={() => {}}
                    disabled
                    result={r}
                  />
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {captions}
    </div>
  );
}

/**
 * Replay-only quiz surface. A replay is a presentation of the persisted
 * lesson, not a second assessment: it must not hydrate an attempt, write a
 * draft/runtime record, call the grading API, or append evidence. Keep this
 * component deliberately stateless and render controls as inert elements so a
 * click in a replay cannot accidentally enter the teaching path.
 */
function QuizPresentationView({ questions }: Pick<QuizViewProps, 'questions'>) {
  const { t } = useI18n();
  const totalPoints = useMemo(
    () => questions.reduce((sum, question) => sum + (question.points ?? 1), 0),
    [questions],
  );

  return (
    <div
      className="w-full h-full bg-gradient-to-b from-gray-50 to-white dark:from-gray-900 dark:to-gray-900 overflow-hidden flex flex-col"
      aria-readonly="true"
      data-quiz-presentation-only
    >
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-100 dark:border-gray-700 bg-white/80 dark:bg-gray-900/80 shrink-0">
        <div className="flex items-center gap-2">
          <PieChart className="w-4 h-4 text-violet-500" />
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
            {t('quiz.title')}
          </span>
        </div>
        <span className="text-xs text-gray-400">
          {questions.length} {t('quiz.questionsCount')} · {totalPoints} {t('quiz.pointsSuffix')}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {questions.map((question, index) => (
          <QuestionCard key={question.id} question={question} index={index}>
            {question.type === 'short_answer' ? (
              <p className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-500">
                {t('quiz.inputPlaceholder')}
              </p>
            ) : (
              <div className="grid gap-2" aria-label="Quiz options">
                {question.options?.map((option) => (
                  <div
                    key={option.value}
                    className="flex items-center gap-3 rounded-xl border border-gray-200 px-4 py-3 text-left text-sm text-gray-600 dark:border-gray-600 dark:text-gray-300"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-bold text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                      {option.value}
                    </span>
                    <QuizMathText text={option.label} />
                  </div>
                ))}
              </div>
            )}
          </QuestionCard>
        ))}
      </div>
    </div>
  );
}

/** Render a quiz either as a teaching assessment or as inert replay content. */
export function QuizView(props: QuizViewProps) {
  const captions = props.showCaptions ? <ClassroomCaptionLayer /> : null;
  if (props.presentationOnly) {
    if (props.html) {
      return (
        <div
          className="relative h-full w-full"
          aria-readonly="true"
          data-quiz-presentation-only
          data-classroom-page-surface
        >
          <HtmlQuizSurface html={props.html} questions={props.questions} stageId={props.stageId} />
          {captions}
        </div>
      );
    }
    return (
      <div className="relative h-full w-full">
        <QuizPresentationView questions={props.questions} />
        {captions}
      </div>
    );
  }
  return <InteractiveQuizView {...props} />;
}
