import { describe, expect, it } from 'vitest';
import enUS from '@/lib/i18n/locales/en-US.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';

describe('edit_elements locale coverage', () => {
  it.each([enUS, zhCN])('defines the client apply-failure correction', (locale) => {
    expect(locale.edit.editElements.applyFailed).toBeTruthy();
    expect(locale.edit.editElements.applyPartiallyFailed).toBeTruthy();
  });
});
