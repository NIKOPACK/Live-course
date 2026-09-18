import { ScanLine, Search, FileText, BookOpen, LayoutPanelLeft } from 'lucide-react';
import type {
  SceneOutline,
  UserRequirements,
  PdfImage,
  ImageMapping,
  SessionDocumentSource,
} from '@/lib/types/generation';
import type { LessonPlan } from '@/lib/livecourse/domain/schemas';
import {
  createGenerationIdentity,
  GenerationIdentityError,
  resolveGenerationIdentity,
  withGenerationIdentity,
  type GenerationIdentity,
} from '@/lib/livecourse/session/generation-identity';

export {
  createGenerationIdentity,
  GenerationIdentityError,
  resolveGenerationIdentity,
  withGenerationIdentity,
};
export type { GenerationIdentity };

// Session state stored in sessionStorage
export interface GenerationSessionState {
  sessionId: string;
  /**
   * Durable generation identity. These values are allocated once on the
   * homepage and carried through refreshes/retries; they are intentionally
   * separate namespaces even though the current product exposes one lesson.
   * Older sessions may omit them and are normalized on preview-page restore.
   */
  courseId?: string;
  stageId?: string;
  lessonId?: string;
  requirements: UserRequirements;
  pdfText: string;
  documentSources?: SessionDocumentSource[];
  pdfImages?: PdfImage[];
  imageStorageIds?: string[];
  imageMapping?: ImageMapping;
  sceneOutlines?: SceneOutline[] | null;
  currentStep: 'generating' | 'complete';
  // 大纲不再是学习者可见的审阅环节（docs/spec/02 生成预览节）：大纲流式完成后
  // 自动进入教案设计，只保留「准备中 / 生成内容中」两个持久化相位。
  previewPhase?: 'preparing' | 'generating-content';
  // 课前确认（预览页内、生成教案之前）是否已完成；完成后刷新不再追问。
  confirmationDone?: boolean;
  // 课前确认是否由学习者主动跳过（用于生成开始时 C intake 的审计字段）。
  confirmationSkipped?: boolean;
  /**
   * The lesson plan is part of the resumable generation envelope.  Keeping it
   * here makes a refresh/retry reuse the same plan (and its createdAt) instead
   * of asking the design endpoint for a second plan under the same course key.
   * `null` is accepted only for sessions written by the legacy flow.
   */
  lessonPlan?: LessonPlan | null;
  // PDF deferred parsing fields
  pdfStorageKey?: string;
  pdfFileName?: string;
  documentMimeType?: string;
  pdfProviderId?: string;
  pdfProviderConfig?: {
    apiKey?: string;
    baseUrl?: string;
    accessKeyId?: string;
    accessKeySecret?: string;
  };
  // Web search context
  researchContext?: string;
  researchSources?: Array<{ title: string; url: string }>;
  // Language directive inferred from outline generation
  languageDirective?: string;
  // Concise course title inferred from outline generation (used as the stage name)
  courseTitle?: string;
  // Server-effective vocational mode from the outline generation done event.
  taskEngineMode?: boolean;
}

export type GenerationStepId =
  | 'pdf-analysis'
  | 'web-search'
  | 'outline'
  | 'lesson-plan'
  | 'slide-content';

export type GenerationStep = {
  id: GenerationStepId;
  title: string;
  description: string;
  icon: React.ElementType;
  type: 'analysis' | 'writing' | 'visual';
};

const MEDIA_EXTENSIONS = new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'mp3', 'wav', 'aac', 'm4a']);

/** True when the uploaded material is audio/video (extraction is transcription). */
function isMediaMaterial(session: GenerationSessionState | null): boolean {
  const mimeType = session?.documentMimeType;
  if (mimeType && (mimeType.startsWith('video/') || mimeType.startsWith('audio/'))) return true;
  const extension = session?.pdfFileName?.split('.').pop()?.trim().toLowerCase();
  return !!extension && MEDIA_EXTENSIONS.has(extension);
}

export function getGenerationStepText(
  step: GenerationStep,
  session: GenerationSessionState | null,
) {
  if (step.id === 'pdf-analysis') {
    // Audio/video use a dedicated string ("Analyzing audio/video") — the
    // generic document copy ("Analyzing documents") would misdescribe them.
    if (isMediaMaterial(session)) {
      return {
        title: 'generation.analyzingMediaMaterial',
        titleValues: undefined,
        description: 'generation.analyzingCourseMaterialDesc',
      };
    }
    return {
      title: 'generation.analyzingCourseMaterial',
      titleValues: undefined,
      description: 'generation.analyzingCourseMaterialDesc',
    };
  }
  return {
    title: step.title,
    titleValues: undefined,
    description: step.description,
  };
}

export const ALL_STEPS: GenerationStep[] = [
  {
    id: 'pdf-analysis',
    title: 'generation.analyzingCourseMaterial',
    description: 'generation.analyzingCourseMaterialDesc',
    icon: ScanLine,
    type: 'analysis',
  },
  {
    id: 'web-search',
    title: 'generation.webSearching',
    description: 'generation.webSearchingDesc',
    icon: Search,
    type: 'analysis',
  },
  {
    id: 'outline',
    title: 'generation.generatingOutlines',
    description: 'generation.generatingOutlinesDesc',
    icon: FileText,
    type: 'writing',
  },
  {
    id: 'lesson-plan',
    title: 'generation.designingLessonPlan',
    description: 'lessonPlan.preparing',
    icon: BookOpen,
    type: 'writing',
  },
  {
    id: 'slide-content',
    title: 'generation.generatingSlideContent',
    description: 'generation.generatingSlideContentDesc',
    icon: LayoutPanelLeft,
    type: 'visual',
  },
];

export const getActiveSteps = (session: GenerationSessionState | null) => {
  return ALL_STEPS.filter((step) => {
    if (step.id === 'pdf-analysis') {
      return Boolean(session?.pdfStorageKey || (session?.documentSources?.length ?? 0) > 0);
    }
    if (step.id === 'web-search') return !!session?.requirements?.webSearch;
    return true;
  });
};
