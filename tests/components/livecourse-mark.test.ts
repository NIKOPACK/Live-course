import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LiveCourseMark } from '@/components/livecourse/LiveCourseMark';

describe('LiveCourseMark', () => {
  it('keeps the accessible wordmark without an image or SVG', () => {
    const markup = renderToStaticMarkup(createElement(LiveCourseMark));
    expect(markup).toContain('aria-label="LiveCourse"');
    expect(markup).toContain('Live');
    expect(markup).toContain('Course');
    expect(markup).not.toMatch(/<(?:svg|img)\b/);
  });

  it('does not leave an empty mark where only the removed icon was shown', () => {
    const markup = renderToStaticMarkup(createElement(LiveCourseMark, { showLabel: false }));
    expect(markup).toBe('');
  });

  it('preserves hero sizing, dark appearance and caller classes', () => {
    const markup = renderToStaticMarkup(
      createElement(LiveCourseMark, { size: 'hero', dark: true, className: 'custom-brand' }),
    );
    expect(markup).toContain('text-4xl md:text-5xl');
    expect(markup).toContain('text-white');
    expect(markup).toContain('custom-brand');
  });
});
