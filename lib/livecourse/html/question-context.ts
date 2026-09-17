import { create } from 'zustand';
import { z } from 'zod';
import { HTML_TEXT_SELECTION_LIMIT } from './teacher-bridge';

export const htmlTextSelectionSchema = z.object({
  __livecourseTeacher: z.literal(true),
  type: z.literal('HTML_TEXT_SELECTED'),
  text: z.string().trim().min(1).max(HTML_TEXT_SELECTION_LIMIT),
});

export interface HtmlQuestionQuote {
  readonly sceneId: string;
  readonly text: string;
}

interface HtmlQuestionContext {
  quote: HtmlQuestionQuote | null;
  setQuote: (quote: HtmlQuestionQuote) => void;
  clearQuote: (expected?: HtmlQuestionQuote) => void;
}

/** A draft attachment only; never a teacher command or persisted learning fact. */
export const useHtmlQuestionContext = create<HtmlQuestionContext>((set) => ({
  quote: null,
  setQuote: (quote) =>
    set((state) =>
      state.quote?.sceneId === quote.sceneId && state.quote.text === quote.text ? state : { quote },
    ),
  clearQuote: (expected) =>
    set((state) => (!expected || state.quote === expected ? { quote: null } : state)),
}));
