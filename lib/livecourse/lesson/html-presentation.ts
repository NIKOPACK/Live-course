import { parseJsonResponse } from '@/lib/generation/json-repair';
import { postProcessInteractiveHtml } from '@/lib/generation/interactive-post-processor';
import { createLogger } from '@/lib/logger';
import type { AICallFn, AgentInfo, SceneGenerationContext } from '@/lib/generation/pipeline-types';
import { buildCourseContext, formatAgentsForPrompt } from '@/lib/generation/prompt-formatters';
import {
  lessonPresentationSchema,
  type LessonPlan,
  type LessonPresentation,
  type LessonNodeDesign,
} from '@/lib/livecourse/domain/schemas';
import type { SubagentRuntime } from '@/lib/livecourse/outline/subagent';
import {
  designLessonPlanWithSubagents,
  formatLessonNodeDesignForPrompt,
  type DesignLessonPlanInput,
  type LessonDesignAICall,
} from './designer';
import { buildLessonPlanSkeleton } from './skeleton';
import type { ImageMapping, PdfImage, SceneOutline } from '@/lib/types/generation';
import type { QuizQuestion } from '@/lib/types/stage';
import { MAX_VISION_IMAGES } from '@/lib/constants/generation';
import { attachHtmlTeacherBridge } from '@/lib/livecourse/html/teacher-bridge';

const log = createLogger('HtmlPresentation');

const VISUAL_DIRECTION_PROMPT = `You are the main agent directing an entire self-paced classroom.
Before any page workers begin, establish ONE distinctive visual direction for this course.
You have creative authority: choose a visual thesis, palette (with usable color values), typography,
spatial rhythm, diagram/illustration language and purposeful motion appropriate to this subject
and learner. Describe how explanations, worked examples, experiments and checks belong to the same
course while using different compositions. Include concrete shared CSS tokens or styling guidance.
Do not prescribe a fixed slide layout, element schema, widget category, or card template.
Prefer legibility, expressive diagrams and meaningful visual hierarchy over decorative chrome.
Respect accessibility, narrow viewports and reduced motion. Pages can use HTML, CSS, inline SVG,
Canvas, MathML and JavaScript. They run inside an isolated iframe, not the application DOM.
Return ONLY JSON: {"visualStyle":"your complete, actionable art direction in the course language"}.`;

/** The main agent commits the visual direction before any node workers run. */
export async function designHtmlLessonPlan(
  input: DesignLessonPlanInput,
  runtime: SubagentRuntime,
  aiCall: LessonDesignAICall,
): Promise<LessonPlan> {
  const raw = await aiCall(
    VISUAL_DIRECTION_PROMPT,
    JSON.stringify({
      requirement: input.requirement,
      courseTitle: input.courseTitle,
      languageDirective: input.languageDirective,
      clarificationAnswers: input.clarificationAnswers,
      selectedTopics: input.selectedTopics,
      outlines: input.outlines,
    }),
  );
  const direction = parseJsonResponse<{ visualStyle?: unknown }>(raw);
  const presentation = lessonPresentationSchema.parse({
    mode: 'html',
    visualStyle: direction?.visualStyle,
  });
  const plan =
    (await designLessonPlanWithSubagents(
      { ...input, visualStyle: presentation.visualStyle },
      runtime,
      aiCall,
    )) ?? buildLessonPlanSkeleton(input);
  return { ...plan, presentation };
}

const HTML_PAGE_PROMPT = `You are authoring one page of a self-paced classroom in HTML.
The main agent has already decided the course's visual direction. Follow it faithfully, while
choosing the best composition for THIS node. You are not filling a slide template.
Use your full design and coding ability: expressive typography, editorial layouts, worked visual
examples, diagrams, simulations, progressive reveals, SVG, Canvas, MathML and meaningful animation.
There is no fixed element inventory, coordinate grid, widget taxonomy, card layout or word quota.
Teach the supplied content accurately and thoroughly; do not reduce it to generic bullet points.
Keep the core explanation visible without clicking. Optional exploration can reveal deeper detail.
Make the page responsive to its actual iframe viewport, readable on small screens, accessible to
keyboard users and respectful of prefers-reduced-motion. Do not add course navigation, a second
teacher, grading, completion tracking, chat, editors or export controls.
Deliver a complete standalone HTML document. The first characters of the response must be
<!DOCTYPE html>. No preface, markdown, JSON wrapper, unfinished code or placeholder explanations.
Prefer inline CSS and JavaScript; established public HTTPS libraries
and fonts are allowed when they materially improve the lesson. No build step or parent-provided
runtime. Keep core teaching content visible while optional resources load, and visibly report
resource failures instead of leaving a blank page. Use supplied lesson media URLs/placeholder IDs;
do not invent source images or media-generation endpoints.
Assign meaningful stable DOM ids to teaching regions so the teacher can highlight them.
The host supplies highlight, annotation and reveal handlers; do not reimplement that protocol.
Runtime boundary: sandboxed iframe with scripts but no same-origin privileges. Do not access parent
DOM, application APIs, credentials or persistent browser storage. Local page interactions are welcome;
they do not advance the lesson or create learning evidence. The host owns speech and lesson progress.`;

const QUIZ_PAGE_CONTRACT = `This is a checkpoint page. Present ALL supplied questions and their input
controls in your own HTML design, using the exact question IDs and option values. Do not invent,
omit or change questions. The host renders trusted start, submit and retry controls OUTSIDE this page;
do not add those controls, score the learner yourself, reveal correct answers or claim completion.
For a user selection call window.livecourseQuiz.setAnswer(questionId, selectedValues) where
selectedValues is a string[] of option values (single choice: at most one). For short_answer call
window.livecourseQuiz.setAnswer(questionId, text). Only call this in response to learner input.
Listen on window for the CustomEvent "livecourse:quiz-state". Its detail includes phase, answers
(an object keyed by question ID), and results. Restore inputs from answers WITHOUT emitting changes;
enable inputs only when phase === "answering". Keep questions visible in every phase. Render
results only from host-provided feedback; never derive your own grade. Initialize inputs disabled
until the first state event. The host sends state on page load and on every state change.`;

function stripReasoningPrefix(response: string): string {
  const trimmed = response.trim();
  const matches = [...trimmed.matchAll(/<\/(?:think|thinking|reasoning)>\s*/gi)];
  const lastMatch = matches.at(-1);
  if (!lastMatch || lastMatch.index === undefined) return trimmed;
  return trimmed.slice(lastMatch.index + lastMatch[0].length).trim();
}

function stripHtmlFences(response: string): string {
  return response
    .trim()
    .replace(/^```(?:html)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();
}

function sliceFromHtmlStart(html: string): string {
  const doctype = html.search(/<!doctype\s+html\b/i);
  const htmlTag = html.search(/<html\b/i);
  if (doctype === -1 && htmlTag === -1) return html;
  const start =
    doctype === -1 ? htmlTag : htmlTag === -1 ? doctype : Math.min(doctype, htmlTag);
  return html.slice(start).trim();
}

function collectHtmlCandidates(response: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (value: string | undefined) => {
    const next = value?.trim();
    if (!next || seen.has(next)) return;
    seen.add(next);
    out.push(next);
  };

  const raw = response.replace(/^\uFEFF/, '').trim();
  const unthink = stripReasoningPrefix(raw);
  push(raw);
  push(unthink);
  push(stripHtmlFences(unthink));

  for (const match of unthink.matchAll(/```(?:html)?\s*([\s\S]*?)```/gi)) {
    push(match[1]);
  }

  if (/^\s*\{/.test(unthink) && /"html"\s*:/.test(unthink)) {
    const wrapped = parseJsonResponse<{ html?: unknown }>(unthink);
    if (typeof wrapped?.html === 'string') push(wrapped.html);
  }

  for (const candidate of [...out]) {
    push(sliceFromHtmlStart(candidate));
  }
  return out;
}

function ensureHtmlShell(html: string): string {
  let out = html.trim();
  if (!/<html\b/i.test(out)) return out;
  if (!/<head\b/i.test(out) && /<body\b/i.test(out)) {
    out = out.replace(/<html\b[^>]*>/i, (open) => `${open}<head></head>`);
  }
  return out;
}

function isCompleteClassroomHtml(html: string): boolean {
  return (
    /^(?:<!doctype\s+html[^>]*>\s*)?<html\b/i.test(html) &&
    /<head\b[^>]*>[\s\S]*<\/head\s*>/i.test(html) &&
    /<body\b[^>]*>[\s\S]*\S[\s\S]*<\/body\s*>/i.test(html) &&
    /<\/html\s*>\s*$/i.test(html)
  );
}

/** Close a truncated classroom page when the body already has real content. */
function closeTruncatedClassroomHtml(html: string): string {
  let out = html.trim();
  const closeHtml = /<\/html\s*>/i.exec(out);
  if (closeHtml && closeHtml.index !== undefined) {
    return out.slice(0, closeHtml.index + closeHtml[0].length).trim();
  }

  if (!/<html\b/i.test(out) || !/<body\b/i.test(out)) return out;

  const bodyOpen = /<body\b[^>]*>/i.exec(out);
  if (!bodyOpen || bodyOpen.index === undefined) return out;
  const bodyContent = out.slice(bodyOpen.index + bodyOpen[0].length);
  if (!bodyContent.replace(/<\/(?:body|html)\s*>/gi, '').trim()) return out;

  if (/<head\b/i.test(out) && !/<\/head\s*>/i.test(out)) {
    out = out.replace(/<body\b/i, '</head>$&');
  }
  if (!/<\/body\s*>/i.test(out)) out += '</body>';
  if (!/<\/html\s*>/i.test(out)) out += '</html>';
  return out;
}

function normalizeClassroomHtml(response: string): string {
  let last = '';
  for (const candidate of collectHtmlCandidates(response)) {
    const html = closeTruncatedClassroomHtml(ensureHtmlShell(candidate));
    last = html;
    if (isCompleteClassroomHtml(html)) return html;
  }
  return last;
}

export class ClassroomHtmlParseError extends Error {
  readonly isRetryable = true;
  override readonly name = 'ClassroomHtmlParseError';

  constructor() {
    super('Classroom page must be a complete HTML document with a non-empty body');
  }
}

export function parseClassroomHtml(response: string): string {
  const html = normalizeClassroomHtml(response);
  if (!isCompleteClassroomHtml(html)) {
    log.warn(
      `Classroom HTML rejected. first=${html.slice(0, 300).replace(/\n/g, '\\n')} last=${html
        .slice(Math.max(0, html.length - 300))
        .replace(/\n/g, '\\n')}`,
    );
    throw new ClassroomHtmlParseError();
  }
  return html;
}

export async function generateHtmlClassroomPage(
  outline: SceneOutline,
  aiCall: AICallFn,
  options: {
    presentation: LessonPresentation;
    lessonNodeDesign?: LessonNodeDesign;
    languageDirective?: string;
    questions?: QuizQuestion[];
    assignedImages?: PdfImage[];
    imageMapping?: ImageMapping;
    visionEnabled?: boolean;
  },
): Promise<string> {
  const media = (outline.mediaGenerations ?? []).map((item) => ({
    id: item.elementId,
    type: item.type,
    purpose: item.prompt,
  }));
  const images = (options.assignedImages ?? []).map((image) => ({
    id: image.id,
    src: options.imageMapping?.[image.id] || image.src,
    description: image.description,
  }));
  const response = await aiCall(
    HTML_PAGE_PROMPT + (options.questions ? `\n\n${QUIZ_PAGE_CONTRACT}` : ''),
    [
      `MAIN AGENT'S COURSE-WIDE VISUAL DIRECTION:\n${options.presentation.visualStyle}`,
      `Language: ${options.languageDirective || 'Use the language of the node content.'}`,
      `Node (its type describes teaching intent, not a layout restriction):\n${JSON.stringify(outline)}`,
      formatLessonNodeDesignForPrompt(options.lessonNodeDesign),
      `Available source images:\n${JSON.stringify(images)}`,
      `Planned media: use the id verbatim in img/video src; the host resolves it later. Provide useful alt text.\n${JSON.stringify(media)}`,
      options.questions
        ? `Checkpoint questions (no grading keys):\n${JSON.stringify(
            options.questions.map(({ id, type, question, options: choices }) => ({
              id,
              type,
              question,
              options: choices,
            })),
          )}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    options.visionEnabled
      ? images.filter((image) => image.src).slice(0, MAX_VISION_IMAGES)
      : undefined,
  );
  const html = parseClassroomHtml(response);
  // Only mathematical pages need the existing LaTeX renderer and its resources.
  const page = /\\\(|\\\[|\$\$/.test(html) ? postProcessInteractiveHtml(html) : html;
  return options.questions ? page : attachHtmlTeacherBridge(page);
}

export function generateHtmlClassroomActionOutput(
  outline: SceneOutline,
  html: string,
  aiCall: AICallFn,
  options: {
    ctx?: SceneGenerationContext;
    agents?: AgentInfo[];
    userProfile?: string;
    languageDirective?: string;
  },
): Promise<string> {
  return aiCall(
    `You are the sole teacher presenting a model-authored HTML classroom page.
Teach the actual page content fully, with clear explanations, worked examples and natural transitions.
Do not treat every page as an exploration widget or shorten a lesson to a generic activity introduction.
Use as many teaching beats as the subject needs. Never voice a second teacher or learner.
Return ONLY a JSON array of {"type":"text","content":"spoken explanation"} and optional
{"type":"action","name":"widget_highlight","params":{"target":"#real-id"}}.
Other supported visual actions: widget_annotation with target/content, widget_reveal with target.
Use only selectors that exist in this HTML; do not invent state APIs or slide actions.
Keep the host in charge of lesson progress. On checkpoints the learner must explicitly submit.
Respect the requested language and continuity: greet only on the first page, not on every page.`,
    [
      `Language: ${options.languageDirective || 'Use the page language.'}`,
      buildCourseContext(options.ctx),
      formatAgentsForPrompt(options.agents),
      options.userProfile || '',
      `Teaching intent:\n${JSON.stringify(outline)}`,
      `Actual HTML page:\n${html}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
}
