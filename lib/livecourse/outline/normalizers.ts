/**
 * Pure, browser-safe normalization for the outline confirmation contracts.
 *
 * The server runners import these helpers too, but the generation-preview
 * client must not import the worker/subagent implementations merely to validate
 * an HTTP response. Keeping the schema-shaped coercion here gives both sides a
 * single source of truth without pulling Node-only code into the browser.
 */
import type {
  ClarifyOption,
  ClarifyQuestion,
  ClarifyResult,
  KnowledgeMap,
  KnowledgeTopic,
} from './types';

function sanitizeOption(raw: unknown, index: number): ClarifyOption | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const option = raw as Record<string, unknown>;
  if (typeof option.label !== 'string' || !option.label.trim()) return null;
  return {
    id: typeof option.id === 'string' && option.id.trim() ? option.id.trim() : `opt_${index + 1}`,
    label: option.label.trim(),
    ...(typeof option.description === 'string' && option.description.trim()
      ? { description: option.description.trim() }
      : {}),
  };
}

function sanitizeQuestion(raw: unknown, index: number): ClarifyQuestion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const question = raw as Record<string, unknown>;
  if (typeof question.question !== 'string' || !question.question.trim()) return null;
  const options = Array.isArray(question.options)
    ? question.options
        .map((option, optionIndex) => sanitizeOption(option, optionIndex))
        .filter((option): option is ClarifyOption => option !== null)
    : [];
  if (options.length < 2) return null;
  return {
    id:
      typeof question.id === 'string' && question.id.trim() ? question.id.trim() : `q_${index + 1}`,
    question: question.question.trim(),
    options: options.slice(0, 6),
    multiSelect: question.multiSelect === true,
  };
}

/** Coerce an untrusted response into a valid clarification result. */
export function normalizeClarifyResult(raw: unknown): ClarifyResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const result = raw as Record<string, unknown>;

  if (result.status === 'ready') {
    return {
      status: 'ready',
      ...(typeof result.reason === 'string' && result.reason.trim()
        ? { reason: result.reason.trim() }
        : {}),
    };
  }

  if (result.status === 'needs_clarification') {
    const questions = Array.isArray(result.questions)
      ? result.questions
          .map((question, index) => sanitizeQuestion(question, index))
          .filter((question): question is ClarifyQuestion => question !== null)
          .slice(0, 3)
      : [];
    if (questions.length === 0) return null;
    return { status: 'needs_clarification', questions };
  }

  return null;
}

export function sanitizeTopic(raw: unknown, path: string): KnowledgeTopic | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const topic = raw as Record<string, unknown>;
  if (typeof topic.title !== 'string' || !topic.title.trim()) return null;
  const children = Array.isArray(topic.children)
    ? topic.children
        .map((child, index) => sanitizeTopic(child, `${path}_${index + 1}`))
        .filter((child): child is KnowledgeTopic => child !== null)
    : undefined;
  return {
    id: typeof topic.id === 'string' && topic.id.trim() ? topic.id.trim() : path,
    title: topic.title.trim(),
    ...(typeof topic.summary === 'string' && topic.summary.trim()
      ? { summary: topic.summary.trim() }
      : {}),
    recommended: topic.recommended === true,
    ...(children && children.length > 0 ? { children } : {}),
  };
}

/** Coerce an untrusted response into a valid knowledge map. */
export function normalizeKnowledgeMap(raw: unknown): KnowledgeMap | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const map = raw as Record<string, unknown>;
  if (typeof map.subject !== 'string' || !map.subject.trim()) return null;
  if (!Array.isArray(map.topics)) return null;
  const topics = map.topics
    .map((topic, index) => sanitizeTopic(topic, `topic_${index + 1}`))
    .filter((topic): topic is KnowledgeTopic => topic !== null);
  return { subject: map.subject.trim(), topics };
}
