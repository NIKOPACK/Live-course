import { parse as parseJavaScript } from 'acorn';
import { parse as parseHtml, type DefaultTreeAdapterTypes } from 'parse5';

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;
type ScriptKind = 'classic script' | 'module script' | 'event handler';

export interface HtmlSyntaxDiagnostic {
  kind: ScriptKind;
  source: string;
  line: number;
  column: number;
  sourceLine: number;
  sourceColumn: number;
  htmlLocation: 'error' | 'source start';
  message: string;
}

export class ClassroomHtmlGenerationError extends Error {
  readonly isRetryable = false;
  override readonly name: string = 'ClassroomHtmlGenerationError';
}

export class ClassroomHtmlSyntaxError extends ClassroomHtmlGenerationError {
  override readonly name = 'ClassroomHtmlSyntaxError';

  constructor(readonly diagnostic: HtmlSyntaxDiagnostic) {
    const { source, line, column, sourceLine, sourceColumn, htmlLocation, message } = diagnostic;
    super(
      `Invalid classroom JavaScript in ${source} at HTML ${line}:${column} (${htmlLocation}) ` +
        `(source ${sourceLine}:${sourceColumn}): ${message}`,
    );
  }
}

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const JAVASCRIPT_TYPES = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

// Unknown on* attributes are data, not browser event handlers (e.g. onboarding).
const EVENT_HANDLERS = new Set(
  `abort animationcancel animationend animationiteration animationstart
  auxclick beforeinput beforematch beforetoggle beforexrselect blur cancel
  canplay canplaythrough change click close command contextlost contextmenu contextrestored
  contentvisibilityautostatechange copy cuechange cut dblclick
  drag dragend dragenter dragleave dragover dragstart drop durationchange emptied ended
  error focus focusin focusout formdata fullscreenchange fullscreenerror
  gotpointercapture input invalid keydown keypress keyup
  load loadeddata loadedmetadata loadstart lostpointercapture
  mousedown mouseenter mouseleave mousemove mouseout mouseover mouseup mousewheel paste
  pause play playing pointercancel pointerdown pointerenter pointerleave pointermove
  pointerout pointerover pointerrawupdate pointerup progress ratechange
  reset resize scroll scrollend scrollsnapchange scrollsnapchanging search
  securitypolicyviolation seeked seeking select selectionchange selectstart show slotchange
  stalled submit suspend timeupdate toggle touchcancel touchend touchmove touchstart
  transitioncancel transitionend transitionrun transitionstart
  volumechange waiting webkitanimationend webkitanimationiteration webkitanimationstart
  webkitfullscreenchange webkitfullscreenerror webkittransitionend wheel`
    .split(/\s+/)
    .map((name) => `on${name}`),
);
const WINDOW_EVENT_HANDLERS = new Set(
  `afterprint beforeprint beforeunload hashchange languagechange message messageerror offline
  online pagehide pagereveal pageshow pageswap popstate rejectionhandled storage
  unhandledrejection unload`
    .split(/\s+/)
    .map((name) => `on${name}`),
);

function isEventHandler(element: Element, name: string): boolean {
  if (EVENT_HANDLERS.has(name)) return true;
  if (element.namespaceURI === HTML_NAMESPACE && ['body', 'frameset'].includes(element.tagName)) {
    return WINDOW_EVENT_HANDLERS.has(name);
  }
  return (
    element.namespaceURI === SVG_NAMESPACE &&
    ['animate', 'animateMotion', 'animateTransform', 'set'].includes(element.tagName) &&
    ['onbegin', 'onend', 'onrepeat'].includes(name)
  );
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((attr) => !attr.namespace && attr.name === name)?.value;
}

function scriptKind(element: Element): Exclude<ScriptKind, 'event handler'> | undefined {
  const type = attribute(element, 'type');
  const language =
    element.namespaceURI === HTML_NAMESPACE ? attribute(element, 'language') : undefined;
  const value = (type === undefined ? (language ? `text/${language}` : '') : type)
    .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '')
    .toLowerCase();
  if (value === 'module') return 'module script';
  if (value !== '' && !JAVASCRIPT_TYPES.has(value)) return undefined;
  // The classroom runs in modern, module-capable browsers.
  if (element.namespaceURI === HTML_NAMESPACE && attribute(element, 'nomodule') !== undefined) {
    return undefined;
  }
  return 'classic script';
}

function boundedMessage(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 180);
}

function validateSource(
  source: string,
  kind: ScriptKind,
  label: string,
  origin: { line: number; column: number; decoded?: boolean },
  handlerParameters = 'event',
): void {
  const prefix = kind === 'event handler' ? `function __handler(${handlerParameters}) {\n` : '';
  const input = prefix ? `${prefix}${source}\n}` : source;
  try {
    const program = parseJavaScript(input, {
      ecmaVersion: 'latest',
      sourceType: kind === 'module script' ? 'module' : 'script',
      locations: true,
    });
    if (prefix) {
      const handler = program.body[0];
      // Parsing a FunctionBody must not let an unmatched } escape the wrapper.
      if (
        program.body.length !== 1 ||
        handler?.type !== 'FunctionDeclaration' ||
        handler.end !== input.length
      ) {
        throw Object.assign(new SyntaxError('Unexpected end of event handler body'), {
          pos: Math.max(prefix.length, (handler?.end ?? prefix.length) - 1),
        });
      }
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const position = (error as SyntaxError & { pos: number }).pos;
    const offset = Math.max(0, Math.min(source.length, position - prefix.length));
    const lines = source.slice(0, offset).split(/\r\n|[\n\r\u2028\u2029]/);
    const sourceLine = lines.length;
    const sourceColumn = lines.at(-1)!.length + 1;
    // Attributes and SVG text may be entity-decoded. Their HTML origin is
    // separate from the exact decoded JavaScript position.
    const sourceStart = Boolean(prefix || origin.decoded);
    throw new ClassroomHtmlSyntaxError({
      kind,
      source: label.slice(0, 80),
      line: sourceStart ? origin.line : origin.line + sourceLine - 1,
      column: sourceStart
        ? origin.column
        : sourceLine === 1
          ? origin.column + sourceColumn - 1
          : sourceColumn,
      sourceLine,
      sourceColumn,
      htmlLocation: sourceStart ? 'source start' : 'error',
      message: boundedMessage(error.message.replace(/ \(\d+:\d+\)$/, '')),
    });
  }
}

/** Static parsing only: never evaluates page code or fetches external resources. */
export function validateClassroomHtmlSyntax(html: string): void {
  const document = parseHtml(html, { sourceCodeLocationInfo: true, scriptingEnabled: true });
  const pending: Node[] = [document];
  let scriptIndex = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if ('tagName' in node) {
      const location = node.sourceCodeLocation;
      for (const attr of node.attrs) {
        if (attr.namespace || !isEventHandler(node, attr.name)) continue;
        const attrLocation = location?.attrs?.[attr.name];
        validateSource(
          attr.value,
          'event handler',
          `${attr.name} on <${node.tagName}>`,
          {
            line: attrLocation?.startLine ?? location?.startLine ?? 1,
            column: attrLocation?.startCol ?? location?.startCol ?? 1,
          },
          attr.name === 'onerror' && ['body', 'frameset'].includes(node.tagName)
            ? 'event, source, lineno, colno, error'
            : 'event',
        );
      }
      if (
        node.tagName === 'script' &&
        [HTML_NAMESPACE, SVG_NAMESPACE].includes(node.namespaceURI)
      ) {
        scriptIndex++;
        const kind = scriptKind(node);
        const external =
          node.namespaceURI === HTML_NAMESPACE
            ? attribute(node, 'src') !== undefined
            : node.attrs.some((attr) => attr.name === 'href');
        // A src attribute (even empty) suppresses the inline body; it is not a fallback.
        if (kind && !external && location?.startTag) {
          const source = node.childNodes
            .filter((child): child is DefaultTreeAdapterTypes.TextNode => 'value' in child)
            .map((child) => child.value)
            .join('');
          validateSource(source, kind, `${kind} #${scriptIndex}`, {
            line: location.startTag.endLine,
            column: location.startTag.endCol,
            decoded: node.namespaceURI === SVG_NAMESPACE,
          });
        }
      }
      // Template content is a separate, inert document fragment, not executable DOM.
      if (node.tagName === 'template' && node.namespaceURI === HTML_NAMESPACE) continue;
    }
    if ('childNodes' in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--) {
        pending.push(node.childNodes[index]);
      }
    }
  }
}
