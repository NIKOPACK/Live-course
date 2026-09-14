import { describe, expect, it } from 'vitest';

import {
  GenerationParamsError,
  generationParamsStorageKey,
  readGenerationParams,
  writeGenerationParams,
} from '@/lib/livecourse/session/generation-params';

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

const params = {
  courseId: 'course-1',
  stageId: 'stage-1',
  lessonId: 'lesson-1',
  pdfImages: [],
};

describe('stage-scoped generation params', () => {
  it('writes and reads only the target stage key', () => {
    const target = storage();
    writeGenerationParams(target, params);

    expect(target.values.has(generationParamsStorageKey('stage-1'))).toBe(true);
    expect(readGenerationParams(target, 'stage-1')).toEqual(params);
    expect(readGenerationParams(target, 'stage-2')).toBeNull();
  });

  it('accepts a legacy global key only when its complete identity matches', () => {
    const target = storage();
    target.values.set('generationParams', JSON.stringify(params));

    expect(readGenerationParams(target, 'stage-1')).toEqual(params);
    expect(() => readGenerationParams(target, 'stage-2')).toThrow(GenerationParamsError);
  });

  it('rejects old unscoped payloads that cannot prove their stage', () => {
    const target = storage();
    target.values.set(
      'generationParams',
      JSON.stringify({ pdfImages: [], agents: [], languageDirective: 'zh-CN' }),
    );

    expect(() => readGenerationParams(target, 'stage-1')).toThrow(GenerationParamsError);
  });

  it('does not fall back to the legacy key when the scoped key is corrupt', () => {
    const target = storage();
    target.values.set(generationParamsStorageKey('stage-1'), '{bad');
    target.values.set('generationParams', JSON.stringify(params));

    expect(() => readGenerationParams(target, 'stage-1')).toThrow(GenerationParamsError);
  });
});
