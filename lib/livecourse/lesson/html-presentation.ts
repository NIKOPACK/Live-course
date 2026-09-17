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
  type OralQuestion,
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
import type { Action } from '@/lib/types/action';
import { declaredCoverPrompt } from './course-cover';

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
Also return coverPrompt: one image-generation prompt for a 16:9 homepage course-cover illustration.
The cover must match visualStyle, depict this course's subject, and use the course language for any visible text.
It is a card thumbnail — not a slide, screenshot, UI chrome, recap strip, or a depiction of HTML / PPT / chalkboard / video as the medium.
Do not put unreadable micro-text or host classroom chrome on the cover.
Return ONLY JSON: {"visualStyle":"your complete, actionable art direction in the course language","coverPrompt":"the cover illustration prompt in the course language"}.`;

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
  const direction = parseJsonResponse<{ visualStyle?: unknown; coverPrompt?: unknown }>(raw);
  const coverPrompt = declaredCoverPrompt(direction?.coverPrompt);
  const presentation = lessonPresentationSchema.parse({
    mode: 'html',
    visualStyle: direction?.visualStyle,
    ...(coverPrompt ? { coverPrompt } : {}),
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
A page heading may sit in the content. The host already shows course title, scene index, teacher
captions and lesson progress — do not duplicate them. Do not add recap footers, takeaway strips
("本页考点一句话", "本节小结"), "已进入…" status, in-page "场景 1/N" chrome, or a second lecture
script that restates what the teacher will say. Spend the viewport on the diagram, table or
worked example. Divide the explanation into
meaningful teaching regions, each with a unique stable DOM id matching [A-Za-z][A-Za-z0-9_-]*.
Worked steps or conclusions may start hidden, but only the teacher's reveal actions should expose
them during narration: do not advance teaching regions using timers, autoplay or learner clicks.
Runtime-created children (trace rows, editor lines, live output) must sit inside a stable parent
id such as #editor, #output or #trace. Teacher actions can only highlight those parent ids.
Optional exploration can reveal deeper detail. Do not hide a teaching region inside a hidden ancestor.
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
  const after = trimmed.slice(lastMatch.index + lastMatch[0].length).trim();
  if (after) return after;
  // The whole payload was inside a think block (DeepSeek-V4 mis-channel).
  const inner = trimmed.match(
    /<(?:think|thinking|reasoning)>\s*([\s\S]*?)\s*<\/(?:think|thinking|reasoning)>/i,
  );
  return inner?.[1]?.trim() || trimmed;
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
  const start = doctype === -1 ? htmlTag : htmlTag === -1 ? doctype : Math.min(doctype, htmlTag);
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
    elementInventory: string;
    oralQuestion?: OralQuestion;
  },
): Promise<string> {
  return aiCall(
    `You are the sole teacher presenting a model-authored HTML classroom page.
Teach the actual page content fully, with clear explanations, worked examples and natural transitions.
Do not treat every page as an exploration widget or shorten a lesson to a generic activity introduction.
Use as many teaching beats as the subject needs. Never voice a second teacher or learner.
Return ONLY a JSON array interleaving visual actions and spoken explanations.
Visual synchronization is REQUIRED, not optional. Split narration into short teaching beats.
BEFORE EVERY {"type":"text","content":"spoken explanation"}, emit
{"type":"action","name":"widget_highlight","params":{"target":"#real-id"}} for the region being
explained. The highlight remains until the next highlight. Move focus as the explanation moves;
do not put all actions at the beginning or end, or narrate the whole page as one long text item.
For a hidden region emit widget_reveal BEFORE its highlight and explanation. Cover every teaching
region and reveal all initially hidden teaching steps by the end.
Do not narrate a recap that restates an on-page takeaway strip.
Other supported visual actions: widget_annotation with target/content, widget_reveal with target.
Use only #id targets from the supplied real element inventory; do not invent selectors, state APIs
or slide actions. Never highlight runtime-only classes such as .trace or .trace-line.
Finish with narration, not a visual action after the explanation has ended.
Keep the host in charge of lesson progress. On checkpoints the learner must explicitly submit.
Respect the requested language and continuity: greet only on the first page, not on every page.`,
    [
      `Language: ${options.languageDirective || 'Use the page language.'}`,
      buildCourseContext(options.ctx),
      formatAgentsForPrompt(options.agents),
      options.userProfile || '',
      `Teaching intent:\n${JSON.stringify(outline)}`,
      `Real element inventory:\n${options.elementInventory}`,
      options.oralQuestion
        ? `The host will ask this oral question after the middle narration beat: ${options.oralQuestion.question}\nUse at least two narration beats. Teach its prerequisites in the first half, leave further explanation for the second half. Do NOT ask or answer the oral question in the script; the live teacher waits for the learner.`
        : '',
      `Actual HTML page:\n${html}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
}

export class ClassroomHtmlActionsError extends Error {
  readonly isRetryable = true;
  override readonly name = 'ClassroomHtmlActionsError';
}

const HTML_ID_RE = /#[A-Za-z][A-Za-z0-9_-]*/;
const HTML_CLASS_RE = /\.([A-Za-z][A-Za-z0-9_-]*)/;

function htmlTeachingIds(inventory: string): Set<string> {
  return new Set([...inventory.matchAll(/^(#[A-Za-z][A-Za-z0-9_-]*) /gm)].map((match) => match[1]));
}

/** Prompt the action model with real #ids only — class lines invite illegal selectors. */
export function htmlTeachingIdInventory(inventory: string): string {
  const section = inventory.split(/\n\n+/).find((part) => part.startsWith('Elements with id:'));
  return section ?? '';
}

function htmlClassToUniqueId(inventory: string): Map<string, string> {
  const unique = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const line of inventory.split('\n')) {
    const id = line.match(/^(#[A-Za-z][A-Za-z0-9_-]*) /)?.[1];
    const classAttr = line.match(/\bclass="([^"]*)"/)?.[1];
    if (!id || !classAttr) continue;
    for (const className of classAttr.split(/\s+/).filter(Boolean)) {
      if (ambiguous.has(className)) continue;
      const existing = unique.get(className);
      if (existing && existing !== id) {
        unique.delete(className);
        ambiguous.add(className);
      } else unique.set(className, id);
    }
  }
  return unique;
}

export function canonicalizeHtmlTeachingTarget(
  raw: unknown,
  inventory: string,
): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const ids = htmlTeachingIds(inventory);
  const idHit = raw.match(HTML_ID_RE)?.[0];
  if (idHit && ids.has(idHit)) return idHit;
  const className = raw.match(HTML_CLASS_RE)?.[1];
  if (className) return htmlClassToUniqueId(inventory).get(className);
  const bare = raw.trim();
  if (ids.has(`#${bare}`)) return `#${bare}`;
  return undefined;
}

function isHtmlVisualAction(
  action: Action,
): action is Extract<Action, { type: 'widget_highlight' | 'widget_annotation' | 'widget_reveal' }> {
  return (
    action.type === 'widget_highlight' ||
    action.type === 'widget_annotation' ||
    action.type === 'widget_reveal'
  );
}

function firstHtmlTeachingId(inventory: string): string | undefined {
  return [...htmlTeachingIds(inventory)][0];
}

/** Map class/descendant selectors onto real #ids; drop visual actions with no target. */
export function normalizeHtmlTeachingActions(
  actions: Action[],
  elementInventory: string,
): Action[] {
  const fallback = firstHtmlTeachingId(elementInventory);
  const next: Action[] = [];
  for (const action of actions) {
    if (!isHtmlVisualAction(action)) {
      next.push(action);
      continue;
    }
    const target = canonicalizeHtmlTeachingTarget(action.target, elementInventory) ?? fallback;
    if (!target) {
      if (typeof action.target === 'string' && action.target.trim()) {
        throw new ClassroomHtmlActionsError(`Unknown HTML teaching target: ${action.target}`);
      }
      continue;
    }
    next.push({ ...action, target });
  }
  return next;
}

/**
 * Recover sequences the action model often emits for interactive labs
 * (class-only selectors, speech before highlight, extra focus, trailing visuals)
 * so generation can finish instead of retrying forever against the same HTML.
 */
export function repairHtmlTeachingActions(
  actions: Action[],
  elementInventory: string,
): Action[] {
  const fallback = firstHtmlTeachingId(elementInventory);
  if (!fallback) {
    throw new ClassroomHtmlActionsError('HTML page has no teaching region ids');
  }
  const repaired: Action[] = [];
  let hasFocus = false;
  let pendingFocus = false;
  for (const action of actions) {
    if (action.type === 'speech') {
      if (!hasFocus) {
        repaired.push({ type: 'widget_highlight', target: fallback });
        hasFocus = true;
      }
      repaired.push(action);
      pendingFocus = false;
      continue;
    }
    if (action.type === 'widget_highlight') {
      if (pendingFocus) continue;
      pendingFocus = true;
      hasFocus = true;
    }
    repaired.push(action);
  }
  while (repaired.length > 0 && isHtmlVisualAction(repaired[repaired.length - 1]!)) {
    repaired.pop();
  }
  return repaired;
}

export function validateHtmlTeachingActions(actions: Action[], elementInventory: string): void {
  const targets = htmlTeachingIds(elementInventory);
  if (!actions.some((action) => action.type === 'speech')) {
    throw new ClassroomHtmlActionsError('No teacher narration generated for HTML page');
  }
  let hasFocus = false;
  let pendingFocus = false;
  for (const action of actions) {
    if (action.type === 'speech') {
      if (!hasFocus) {
        throw new ClassroomHtmlActionsError('HTML narration requires a preceding highlight');
      }
      pendingFocus = false;
    } else if (isHtmlVisualAction(action)) {
      if (!targets.has(action.target)) {
        throw new ClassroomHtmlActionsError(`Unknown HTML teaching target: ${action.target}`);
      }
      if (action.type === 'widget_highlight') {
        if (pendingFocus) {
          throw new ClassroomHtmlActionsError(
            'Each HTML teaching focus requires its own narration',
          );
        }
        pendingFocus = true;
        hasFocus = true;
      }
    }
  }
  if (actions.at(-1)?.type !== 'speech') {
    throw new ClassroomHtmlActionsError('HTML teaching actions must precede their narration');
  }
}
