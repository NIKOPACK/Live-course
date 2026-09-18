import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClassroomHtmlSyntaxError,
  validateClassroomHtmlSyntax,
} from '@/lib/livecourse/html/syntax-validator';

const page = (body: string) => `<!DOCTYPE html><html><head></head><body>${body}</body></html>`;

describe('classroom HTML static JavaScript validation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    'const value = { answer: 1;',
    'const value = { answer: 1 next: 2 };',
    'const value = "unfinished;',
    'function render() {',
    'const value = /unterminated;',
  ])('rejects invalid JavaScript in a complete shell: %s', (source) => {
    expect(() => validateClassroomHtmlSyntax(page(`<script>${source}</script>`))).toThrow(
      ClassroomHtmlSyntaxError,
    );
  });

  it('supports modern classic syntax, strings, regular expressions and template literals', () => {
    const source =
      String.raw`
      const closing = "<\/script> </html>";
      const object = { text: 'a } in a string', pattern: /[{}]/g };
      const template = ` +
      '`value: ${object?.text ?? "missing"} }`;' +
      String.raw`
      class Example { #value = 1; static { this.ready = true; } get value() { return this.#value; } }
      const big = 1_000n;
      import("./optional.js");
    `;
    expect(() => validateClassroomHtmlSyntax(page(`<script>${source}</script>`))).not.toThrow();
  });

  it('distinguishes classic scripts from modules, including module strict mode', () => {
    const source = 'import value from "./value.js"; export const result = await value;';
    expect(() =>
      validateClassroomHtmlSyntax(page(`<script type="module">${source}</script>`)),
    ).not.toThrow();
    expect(() => validateClassroomHtmlSyntax(page(`<script>${source}</script>`))).toThrow(
      ClassroomHtmlSyntaxError,
    );
    expect(() =>
      validateClassroomHtmlSyntax(page('<script type="module">with ({}) {}</script>')),
    ).toThrow(ClassroomHtmlSyntaxError);
    expect(() => validateClassroomHtmlSyntax(page('<script>with ({}) {}</script>'))).not.toThrow();
  });

  it.each([
    'application/json',
    'application/ld+json',
    'importmap',
    'speculationrules',
    'text/plain',
  ])('does not parse inert %s scripts as JavaScript', (type) => {
    expect(() =>
      validateClassroomHtmlSyntax(page(`<script type="${type}">{"unfinished":</script>`)),
    ).not.toThrow();
  });

  it('honors JavaScript MIME aliases, the legacy language attribute and an explicitly empty type', () => {
    for (const attributes of [
      'type=" TEXT/JAVASCRIPT "',
      'type="application/ecmascript"',
      'language="JavaScript"',
      'type="" language="json"',
    ]) {
      expect(() =>
        validateClassroomHtmlSyntax(page(`<script ${attributes}>const broken = ;</script>`)),
      ).toThrow(ClassroomHtmlSyntaxError);
    }
    expect(() =>
      validateClassroomHtmlSyntax(page('<script language="json">{"unfinished":</script>')),
    ).not.toThrow();
  });

  it('ignores comments, escaped markup, raw text and inert template contents', () => {
    expect(() =>
      validateClassroomHtmlSyntax(
        page(`
          <!-- <script>const broken = ;</script> -->
          <template><script>const broken = ;</script><button onclick="return {;">A</button></template>
          <textarea><script>const broken = ;</script></textarea>
          <noscript><script>const broken = ;</script></noscript>
          <pre>&lt;script&gt;const broken = ;&lt;/script&gt;</pre>
          <div data-code="<script>const broken = ;</script>" onboarding="not JavaScript"></div>
        `),
      ),
    ).not.toThrow();
  });

  it('uses actual HTML script boundaries rather than JavaScript-looking strings', () => {
    expect(() =>
      validateClassroomHtmlSyntax(page('<script>const text = "</script>";</script>')),
    ).toThrow(ClassroomHtmlSyntaxError);
    expect(() =>
      validateClassroomHtmlSyntax(page(String.raw`<script>const text = "<\/script>";</script>`)),
    ).not.toThrow();
  });

  it('parses event handlers as function bodies with decoded entities, return and new.target', () => {
    expect(() =>
      validateClassroomHtmlSyntax(
        page(
          '<button onclick="if (event.key === &quot;}&quot;) return false; return new.target;">A</button>',
        ),
      ),
    ).not.toThrow();
    for (const handler of [
      'return {;',
      'return &quot;broken;',
      '}',
      '} {',
      'return await x;',
      'let event;',
    ]) {
      expect(() =>
        validateClassroomHtmlSyntax(page(`<button onclick="${handler}">A</button>`)),
      ).toThrow(ClassroomHtmlSyntaxError);
    }
    expect(() => validateClassroomHtmlSyntax(page('<img onerror="return {;">'))).toThrow(
      ClassroomHtmlSyntaxError,
    );
  });

  it('never fetches src scripts or parses their ignored inline fallback, even for an empty src', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(() =>
      validateClassroomHtmlSyntax(
        page(`
          <script src="https://example.invalid/library.js">const broken = ;</script>
          <script src="">const broken = ;</script>
          <script type="module" src="./module.js">const broken = ;</script>
          <script nomodule>const broken = ;</script>
          <svg><script href="./external.js">const broken = ;</script></svg>
        `),
      ),
    ).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(() =>
      validateClassroomHtmlSyntax(page('<script src="" onerror="return {;"></script>')),
    ).toThrow(ClassroomHtmlSyntaxError);
  });

  it.each([
    '<html><head></head><body><p>Lesson</p><body onload="HANDLER"></body></html>',
    '<html><head></head><body><html onclick="HANDLER"></body></html>',
    '<html><head></head><p>Lesson</p><body onload="HANDLER"></body></html>',
  ])('validates adopted handlers even without attribute locations: %s', (html) => {
    expect(() => validateClassroomHtmlSyntax(html.replace('HANDLER', 'const broken = ;'))).toThrow(
      ClassroomHtmlSyntaxError,
    );
    expect(() =>
      validateClassroomHtmlSyntax(html.replace('HANDLER', 'return false;')),
    ).not.toThrow();
  });

  it('validates executable SVG scripts and handlers', () => {
    expect(() =>
      validateClassroomHtmlSyntax(page('<svg><script>const broken = ;</script></svg>')),
    ).toThrow(ClassroomHtmlSyntaxError);
    expect(() => validateClassroomHtmlSyntax(page('<svg onload="return {;"></svg>'))).toThrow(
      ClassroomHtmlSyntaxError,
    );
    expect(() =>
      validateClassroomHtmlSyntax(page('<svg><animate onbegin="return {;"></animate></svg>')),
    ).toThrow(ClassroomHtmlSyntaxError);
    expect(() =>
      validateClassroomHtmlSyntax(
        page('<svg><script><![CDATA[const text = "<tag>";]]></script></svg>'),
      ),
    ).not.toThrow();
    expect(() =>
      validateClassroomHtmlSyntax(
        page('<svg><script>const text = &quot;value&quot;;</script></svg>'),
      ),
    ).not.toThrow();
  });

  it('only treats WindowEventHandlers as executable on body and frameset elements', () => {
    expect(() =>
      validateClassroomHtmlSyntax(page('<div onmessage="not JavaScript"></div>')),
    ).not.toThrow();
    expect(() =>
      validateClassroomHtmlSyntax('<html><body onmessage="return {;">A</body></html>'),
    ).toThrow(ClassroomHtmlSyntaxError);
    expect(() =>
      validateClassroomHtmlSyntax('<html><body onerror="let error;">A</body></html>'),
    ).toThrow(ClassroomHtmlSyntaxError);
  });

  it('does not execute side effects in scripts or event handlers', () => {
    const effect = vi.fn();
    vi.stubGlobal('__syntaxValidationEffect', effect);
    validateClassroomHtmlSyntax(
      page(`<script>globalThis.__syntaxValidationEffect(); throw new Error("not executed");</script>
        <img onerror="globalThis.__syntaxValidationEffect()">`),
    );
    expect(effect).not.toHaveBeenCalled();
  });

  it('reports a bounded source-specific diagnostic with HTML and JavaScript locations', () => {
    try {
      validateClassroomHtmlSyntax(
        '<html>\n<head></head>\n<body>\n<script>\nconst broken = ;\n</script></body></html>',
      );
      expect.fail('Expected a syntax error');
    } catch (error) {
      expect(error).toMatchObject({
        isRetryable: false,
        diagnostic: {
          kind: 'classic script',
          source: 'classic script #1',
          line: 5,
          column: 16,
          sourceLine: 2,
          sourceColumn: 16,
        },
      });
      expect((error as Error).message.length).toBeLessThan(400);
    }
    try {
      validateClassroomHtmlSyntax(
        '<html><body>\n<button onclick="return &quot;x;">A</button></body></html>',
      );
      expect.fail('Expected a syntax error');
    } catch (error) {
      expect(error).toMatchObject({
        diagnostic: {
          kind: 'event handler',
          source: 'onclick on <button>',
          line: 2,
          column: 9,
          sourceLine: 1,
          sourceColumn: 8,
        },
      });
    }
  });

  it('bounds diagnostics even when a custom element and identifier are exceptionally long', () => {
    const name = 'x'.repeat(5000);
    try {
      validateClassroomHtmlSyntax(
        page(`<custom-${name} onclick="let ${name}; let ${name};">A</custom-${name}>`),
      );
      expect.fail('Expected a syntax error');
    } catch (error) {
      expect(error).toBeInstanceOf(ClassroomHtmlSyntaxError);
      expect((error as Error).message.length).toBeLessThan(400);
    }
  });
});
