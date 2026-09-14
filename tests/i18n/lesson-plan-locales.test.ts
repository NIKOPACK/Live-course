import { describe, expect, it } from 'vitest';
import { supportedLocales } from '@/lib/i18n/locales';
import enUS from '@/lib/i18n/locales/en-US.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';

const locales = {
  'en-US': enUS,
  'zh-CN': zhCN,
} as const;

const lessonPlanKeys = [
  'lessonPlan.preparing',
  'lessonPlan.toggle',
  'lessonPlan.teachingPoints',
  'lessonPlan.anticipatedQuestions',
  'lessonPlan.explanationPlan',
  'lessonPlan.examples',
  'lessonPlan.hide',
  'generation.viewSegment',
  'generation.hideSegment',
  'generation.classroomPreview',
  'home.generatingCourse',
] as const;

function getKey(locale: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    return (value as Record<string, unknown>)[key];
  }, locale);
}

describe('lesson plan locale coverage', () => {
  it('ships only Chinese and English UI locales', () => {
    expect(supportedLocales.map((locale) => locale.code)).toEqual(['zh-CN', 'en-US']);
  });

  it('defines lesson plan copy in every supported locale', () => {
    for (const [localeCode, localeData] of Object.entries(locales)) {
      for (const key of lessonPlanKeys) {
        const value = getKey(localeData, key);

        expect(value, `${localeCode} is missing ${key}`).toBeTypeOf('string');
        expect(value, `${localeCode} should not echo ${key}`).not.toBe(key);
        expect((value as string).trim(), `${localeCode} has empty ${key}`).not.toBe('');
      }
    }
  });
});
