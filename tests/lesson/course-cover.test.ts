import { describe, expect, it } from 'vitest';
import {
  COURSE_COVER_ASPECT_RATIO,
  COURSE_COVER_ELEMENT_ID,
  declaredCoverPrompt,
  fallbackCoverPrompt,
  resolveCoverPrompt,
  shouldGenerateCourseCover,
} from '@/lib/livecourse/lesson/course-cover';

describe('course cover declaration', () => {
  it('skips when image generation is off or a cover already exists', () => {
    expect(
      shouldGenerateCourseCover({ imageGenerationEnabled: false, coverAssetId: undefined }),
    ).toBe(false);
    expect(
      shouldGenerateCourseCover({ imageGenerationEnabled: true, coverAssetId: 'asset-1' }),
    ).toBe(false);
    expect(shouldGenerateCourseCover({ imageGenerationEnabled: true })).toBe(true);
  });

  it('keeps a declared prompt and falls back from title plus visual style', () => {
    expect(declaredCoverPrompt('  A teal Fourier cover  ')).toBe('A teal Fourier cover');
    expect(declaredCoverPrompt('   ')).toBeUndefined();
    expect(declaredCoverPrompt(12)).toBeUndefined();

    const fallback = fallbackCoverPrompt({
      courseTitle: '傅里叶变换入门',
      visualStyle: 'Warm paper and teal diagrams.',
      language: '简体中文',
    });
    expect(fallback).toContain('傅里叶变换入门');
    expect(fallback).toContain('16:9');
    expect(fallback).toContain('简体中文');
    expect(fallback).toContain('homepage card thumbnail');

    expect(
      resolveCoverPrompt('Paint a waveform over warm paper.', {
        courseTitle: '傅里叶变换入门',
        visualStyle: 'Warm paper and teal diagrams.',
      }),
    ).toBe('Paint a waveform over warm paper.');
    expect(
      resolveCoverPrompt(undefined, {
        courseTitle: '傅里叶变换入门',
        visualStyle: 'Warm paper and teal diagrams.',
      }),
    ).toContain('傅里叶变换入门');
  });

  it('exports the reserved cover identity used by both generation paths', () => {
    expect(COURSE_COVER_ELEMENT_ID).toBe('course_cover');
    expect(COURSE_COVER_ASPECT_RATIO).toBe('16:9');
  });
});
