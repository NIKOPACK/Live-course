import { isChatMessageSkeleton, isQuizAttemptSkeleton } from '@livecourse/dsl';
import type { RuntimePayloadValidator } from '@livecourse/storage';
import { z } from 'zod';

import { whiteboardRuntimePayloadValidator } from '@/lib/whiteboard/runtime/validate';
import { evidenceRecordSchema } from '@/lib/livecourse/domain';
import {
  classroomWorkingMemorySchema,
  courseMemoryRecordSchema,
  learnerMemorySchema,
} from '@/lib/livecourse/memory/schemas';
import { courseStateSnapshotSchema } from '@/lib/livecourse/session/course-state-snapshot';

const zodValidator =
  (schema: z.ZodType): RuntimePayloadValidator =>
  (payload) => {
    const result = schema.safeParse(payload);
    if (result.success) return { valid: true };
    return {
      valid: false,
      errors: result.error.issues.map((issue) => ({
        path: `/payload/${issue.path.join('/')}`,
        message: issue.message,
      })),
    };
  };

const chat: RuntimePayloadValidator = (payload) =>
  isChatMessageSkeleton(payload)
    ? { valid: true }
    : {
        valid: false,
        errors: [
          {
            path: '/payload',
            message: 'chat payload must match ChatMessageSkeleton (role + content)',
          },
        ],
      };

const quizAttempt: RuntimePayloadValidator = (payload) =>
  isQuizAttemptSkeleton(payload)
    ? { valid: true }
    : {
        valid: false,
        errors: [
          {
            path: '/payload',
            message: 'quizAttempt payload must match QuizAttemptSkeleton (phase + answers)',
          },
        ],
      };

const livecourseEvidence: RuntimePayloadValidator = (payload) => {
  const result = evidenceRecordSchema.safeParse(payload);
  if (result.success) return { valid: true };
  return {
    valid: false,
    errors: result.error.issues.map((issue) => ({
      path: `/payload/${issue.path.join('/')}`,
      message: issue.message,
    })),
  };
};

const livecourseCourseState: RuntimePayloadValidator = (payload) => {
  const result = courseStateSnapshotSchema.safeParse(payload);
  if (result.success) return { valid: true };
  return {
    valid: false,
    errors: result.error.issues.map((issue) => ({
      path: `/payload/${issue.path.join('/')}`,
      message: issue.message,
    })),
  };
};

/** Complete app validator table. RuntimeStore options replace their defaults. */
export const APP_RUNTIME_PAYLOAD_VALIDATORS = Object.freeze({
  chat,
  livecourseCourseState,
  livecourseEvidence,
  livecourseWorkingMemory: zodValidator(classroomWorkingMemorySchema),
  livecourseCourseMemory: zodValidator(courseMemoryRecordSchema),
  livecourseLearnerMemory: zodValidator(learnerMemorySchema),
  quizAttempt,
  whiteboard: whiteboardRuntimePayloadValidator,
}) satisfies Readonly<Record<string, RuntimePayloadValidator>>;
