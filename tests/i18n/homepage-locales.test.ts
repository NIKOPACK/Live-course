import { describe, expect, it } from 'vitest';
import { supportedLocales } from '@/lib/i18n/locales';
import enUS from '@/lib/i18n/locales/en-US.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';

const locales = { 'zh-CN': zhCN, 'en-US': enUS };
const homeKeys = [
  'heroTitle',
  'boardTitle',
  'boardNote',
  'exampleLabel1',
  'exampleLabel2',
  'exampleLabel3',
  'deleteCourse',
  'deleteCourseAria',
  'deleteCourseTitle',
  'deleteCourseDescription',
  'deleteCourseConfirm',
  'deleteCourseDeleting',
  'deleteCourseFailed',
] as const;

describe('homepage locale coverage', () => {
  it('provides the classroom introduction and example labels in every supported language', () => {
    expect(Object.keys(locales).sort()).toEqual(
      supportedLocales.map((locale) => locale.code).sort(),
    );
    for (const { code } of supportedLocales) {
      for (const key of homeKeys) {
        const value = locales[code].home[key];
        expect(value.trim(), `${code}: home.${key}`).not.toBe('');
        expect(value, `${code}: home.${key}`).not.toBe(`home.${key}`);
      }
    }
  });
});
