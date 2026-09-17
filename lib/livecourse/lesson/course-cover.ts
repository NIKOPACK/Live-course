/**
 * 课程封面声明（docs/spec/04-detailed-design.md §7，A5.2）。
 *
 * 封面是文档级配图，不是教案节点 visualAids，也不进入 outline.mediaGenerations。
 * 主 Agent 只在视觉方向 JSON 里声明 coverPrompt；本模块解析、fallback 与跳过。
 * 执行走既有图片通道，本文件不发起任何图片 API 调用。
 */

export const COURSE_COVER_ELEMENT_ID = 'course_cover';
export const COURSE_COVER_ASPECT_RATIO = '16:9' as const;
export const COURSE_COVER_PROMPT_MAX_LENGTH = 1500;

export function shouldGenerateCourseCover(input: {
  imageGenerationEnabled: boolean;
  coverAssetId?: string;
}): boolean {
  return input.imageGenerationEnabled && !input.coverAssetId?.trim();
}

export function fallbackCoverPrompt(input: {
  courseTitle?: string;
  visualStyle: string;
  language?: string;
}): string {
  const title = input.courseTitle?.trim() || 'this course';
  const style = input.visualStyle.trim();
  const styleExcerpt = style.length > 600 ? `${style.slice(0, 600)}…` : style;
  const language = input.language?.trim();
  const languageLine = language
    ? `Any visible text must be in ${language}.`
    : 'Any visible text must use the course language.';
  return clipCoverPrompt(
    [
      `Create a 16:9 course cover illustration for "${title}".`,
      'It is a homepage card thumbnail, not a slide, screenshot, UI chrome, or classroom page.',
      'No recap strips, slide numbers, or host toolbars.',
      'Do not depict HTML, PPT, chalkboard, or a video player as the subject.',
      languageLine,
      styleExcerpt ? `Match this visual direction: ${styleExcerpt}` : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
}

export function resolveCoverPrompt(
  declared: unknown,
  fallback: {
    courseTitle?: string;
    visualStyle: string;
    language?: string;
  },
): string {
  if (typeof declared === 'string') {
    const trimmed = declared.trim();
    if (trimmed) return clipCoverPrompt(trimmed);
  }
  return fallbackCoverPrompt(fallback);
}

export function declaredCoverPrompt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? clipCoverPrompt(trimmed) : undefined;
}

function clipCoverPrompt(prompt: string): string {
  return prompt.length <= COURSE_COVER_PROMPT_MAX_LENGTH
    ? prompt
    : prompt.slice(0, COURSE_COVER_PROMPT_MAX_LENGTH);
}
