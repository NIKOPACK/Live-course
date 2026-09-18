import { z } from 'zod';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const identifierSchema = z.string().trim().min(1).max(240);
export const timestampSchema = z.string().datetime({ offset: true });

export const goalRuleSchema = z
  .object({
    version: identifierSchema,
    passScore: z.number().min(0).max(1),
    minAcceptedEvidence: z.number().int().positive(),
    minPassingEvidence: z.number().int().positive(),
  })
  .strict()
  .refine((rule) => rule.minPassingEvidence <= rule.minAcceptedEvidence, {
    message: 'minPassingEvidence cannot exceed minAcceptedEvidence',
    path: ['minPassingEvidence'],
  });

export const learningGoalSchema = z
  .object({
    id: identifierSchema,
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().max(2000).optional(),
    rule: goalRuleSchema,
  })
  .strict();

/**
 * 预设学生提问与回应（docs/spec/04-detailed-design.md §5，A1）。
 * 教案设计 Agent 预判学习者在该节点最可能卡住的提问，并备好应对口径。
 */
export const anticipatedQuestionSchema = z
  .object({
    question: z.string().trim().min(1).max(500),
    response: z.string().trim().min(1),
  })
  .strict();

export const oralQuestionSchema = z
  .object({
    question: z.string().trim().min(1).max(500),
    guidance: z.string().trim().min(1).max(1500),
  })
  .strict();

export type OralQuestion = z.infer<typeof oralQuestionSchema>;

export const lessonTeachingBriefSchema = z
  .object({
    throughline: z.string().trim().min(1),
    estimatedDurationSeconds: z.number().int().positive().optional(),
  })
  .strict();

/**
 * 声明式配图意图（docs/spec/04-detailed-design.md §5，A5）。
 * 教案设计 Agent 只为确有需要静态示意图的讲授节点声明配图；
 * 逐段内容生成前由 lib/livecourse/lesson/visual-aids.ts 合并进对应
 * outline 的 mediaGenerations，执行走既有媒体通道，教案侧不调图片 API。
 */
export const lessonVisualAidSchema = z
  .object({
    /** 全局唯一占位 id（全课范围，如 lesson_img_<sceneId>_1），复用同一 id 即跨场景复用同一张图 */
    id: z.string().trim().min(1).max(100),
    /** 给图片生成模型的 prompt；图内有文字时必须写明文字语言 */
    prompt: z.string().trim().min(1).max(1000),
    /** 讲授用途：这张图帮学习者看懂什么 */
    purpose: z.string().trim().min(1).max(500).optional(),
    /** 与 MediaGenerationRequest.aspectRatio 对齐 */
    aspectRatio: z.enum(['1:1', '16:9', '9:16', '4:3']).optional(),
  })
  .strict();

/**
 * 节点讲授设计：这个节点具体讲什么、怎么讲、学生可能问什么。
 * 全部可选挂在节点上，旧课（反推教案）没有它也能解析。
 */
export const lessonNodeDesignSchema = z
  .object({
    /** 本节点要讲清的具体要点，按讲授顺序排列 */
    teachingPoints: z.array(z.string().trim().min(1)).min(1),
    /** 怎么讲：引入、展开、小结的组织方式 */
    explanationPlan: z.string().trim().min(1),
    examples: z.array(z.string().trim().min(1)).optional(),
    anticipatedQuestions: z.array(anticipatedQuestionSchema).optional(),
    oralQuestion: oralQuestionSchema.optional(),
    /** 易错点 / 常见误解，检查时重点验证 */
    misconceptions: z.array(z.string().trim().min(1)).optional(),
    /** 声明式配图意图（A5）；不需要配图的节点省略 */
    visualAids: z.array(lessonVisualAidSchema).max(3).optional(),
  })
  .strict();

export const lessonNodeSchema = z
  .object({
    id: identifierSchema,
    sceneId: identifierSchema,
    title: z.string().trim().min(1).max(500),
    type: z.enum(['instruction', 'checkpoint', 'interactive', 'project']),
    order: z.number().int().nonnegative(),
    goalIds: z.array(identifierSchema),
    design: lessonNodeDesignSchema.optional(),
  })
  .strict();

export const lessonPresentationSchema = z
  .object({
    mode: z.literal('html'),
    visualStyle: z.string().trim().min(1).max(12000),
    /** Homepage cover illustration prompt; optional so a bad cover cannot fail visual direction. */
    coverPrompt: z.string().trim().min(1).max(1500).optional(),
  })
  .strict();

export const lessonPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: identifierSchema,
    courseId: identifierSchema,
    stageId: identifierSchema,
    title: z.string().trim().min(1).max(500),
    version: z.number().int().positive(),
    status: z.enum(['draft', 'approved', 'archived']),
    createdAt: timestampSchema,
    goals: z.array(learningGoalSchema),
    nodes: z.array(lessonNodeSchema),
    presentation: lessonPresentationSchema.optional(),
    teachingBrief: lessonTeachingBriefSchema.optional(),
  })
  .strict()
  .superRefine((plan, context) => {
    const goalIds = new Set<string>();
    for (const [index, goal] of plan.goals.entries()) {
      if (goalIds.has(goal.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate goal id: ${goal.id}`,
          path: ['goals', index, 'id'],
        });
      }
      goalIds.add(goal.id);
    }

    const nodeIds = new Set<string>();
    const sceneIds = new Set<string>();
    for (const [index, node] of plan.nodes.entries()) {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate node id: ${node.id}`,
          path: ['nodes', index, 'id'],
        });
      }
      if (sceneIds.has(node.sceneId)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate scene id: ${node.sceneId}`,
          path: ['nodes', index, 'sceneId'],
        });
      }
      nodeIds.add(node.id);
      sceneIds.add(node.sceneId);
      for (const [goalIndex, goalId] of node.goalIds.entries()) {
        if (!goalIds.has(goalId)) {
          context.addIssue({
            code: 'custom',
            message: `Unknown goal id: ${goalId}`,
            path: ['nodes', index, 'goalIds', goalIndex],
          });
        }
      }
    }
  });

const deterministicEvaluationSchema = z
  .object({
    method: z.literal('deterministic'),
    ruleVersion: identifierSchema,
  })
  .strict();

const modelEvaluationSchema = z
  .object({
    method: z.literal('model'),
    modelId: identifierSchema,
    rubricVersion: identifierSchema,
    inputSummary: z.string().trim().min(1).max(2000),
    confidence: z.number().min(0).max(1),
    reviewStatus: z.enum(['pending', 'approved', 'rejected']),
  })
  .strict();

const humanEvaluationSchema = z
  .object({
    method: z.literal('human'),
    reviewerId: identifierSchema,
    rubricVersion: identifierSchema.optional(),
  })
  .strict();

export const evidenceEvaluationSchema = z.discriminatedUnion('method', [
  deterministicEvaluationSchema,
  modelEvaluationSchema,
  humanEvaluationSchema,
]);

export const evidenceRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: identifierSchema,
    courseId: identifierSchema,
    lessonId: identifierSchema,
    learnerId: identifierSchema,
    goalId: identifierSchema,
    nodeId: identifierSchema,
    source: z.enum(['checkpoint', 'homework', 'teacher_review']),
    kind: z.enum(['objective_score', 'rubric_score', 'self_report']),
    status: z.enum(['accepted', 'pending_review', 'rejected']),
    score: z.number().min(0).max(1).optional(),
    occurredAt: timestampSchema,
    idempotencyKey: identifierSchema,
    evaluation: evidenceEvaluationSchema,
    metadata: z.record(z.string(), jsonValueSchema).optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.status !== 'rejected' && record.score === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Accepted and pending evidence require a normalized score',
        path: ['score'],
      });
    }
    if (record.kind === 'self_report' && record.status === 'accepted') {
      context.addIssue({
        code: 'custom',
        message: 'Self reports cannot be accepted as mastery evidence',
        path: ['status'],
      });
    }
    if (record.evaluation.method === 'model') {
      const expectedStatus =
        record.evaluation.reviewStatus === 'approved'
          ? 'accepted'
          : record.evaluation.reviewStatus === 'rejected'
            ? 'rejected'
            : 'pending_review';
      if (record.status !== expectedStatus) {
        context.addIssue({
          code: 'custom',
          message: `Model review status requires evidence status ${expectedStatus}`,
          path: ['status'],
        });
      }
    }
  });

export const goalStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    courseId: identifierSchema,
    learnerId: identifierSchema,
    goalId: identifierSchema,
    ruleVersion: identifierSchema,
    status: z.enum(['not_started', 'in_progress', 'met', 'needs_support']),
    evidenceIds: z.array(identifierSchema),
    acceptedEvidenceCount: z.number().int().nonnegative(),
    pendingReviewCount: z.number().int().nonnegative(),
    passingEvidenceCount: z.number().int().nonnegative(),
    latestScore: z.number().min(0).max(1).nullable(),
    averageScore: z.number().min(0).max(1).nullable(),
    updatedAt: timestampSchema.nullable(),
  })
  .strict();

const actionEnvelopeShape = {
  schemaVersion: z.literal(1),
  id: identifierSchema,
  courseId: identifierSchema,
  lessonId: identifierSchema,
  nodeId: identifierSchema,
  sequence: z.number().int().nonnegative(),
  timestamp: timestampSchema,
  idempotencyKey: identifierSchema,
};

const actionSchema = <TType extends string, T extends z.ZodRawShape>(
  type: TType,
  payload: z.ZodObject<T>,
) =>
  z
    .object({
      ...actionEnvelopeShape,
      type: z.literal(type),
      payload,
    })
    .strict();

const emptyPayloadSchema = z.object({}).strict();

export const teachingActionSchema = z.discriminatedUnion('type', [
  actionSchema('lesson.pause', emptyPayloadSchema),
  actionSchema('lesson.resume', emptyPayloadSchema),
  // J3.1：节点加载 / 播放失败后的显式重试。它只记录一次重试意图，
  // 不改变课堂状态、不产生 evidence，也不能被暂停回调代替。
  actionSchema('lesson.retry', emptyPayloadSchema),
  actionSchema('lesson.goto_node', z.object({ targetNodeId: identifierSchema }).strict()),
  // J3.2 自然插话：进入 interrupted 的命令在冻结位置（原节点）提交，
  // action.nodeId 即被冻结的 resumeNode；识别失败只提示重说、不迁移状态。
  actionSchema(
    'lesson.interrupt',
    z.object({ question: z.string().trim().min(1).max(2_000).optional() }).strict(),
  ),
  // J3.2 教师确认、回答后显式派发的恢复命令：唯一允许离开 interrupted
  // 回到 resumeNode 的路径，targetNodeId 必须等于被冻结的 resumeNode。
  actionSchema('lesson.resume_interrupted', z.object({ targetNodeId: identifierSchema }).strict()),
  // J3.6 课中重听：targetNodeId 只许在已讲范围内；回放位置写 W
  // （nodeId = targetNodeId）。不新增 EvidenceRecord、不重判 GoalState。
  actionSchema('lesson.relisten_start', z.object({ targetNodeId: identifierSchema }).strict()),
  // J3.6 返回原位置：targetNodeId = 进入重听前的位置（originNode）。
  actionSchema('lesson.relisten_end', z.object({ targetNodeId: identifierSchema }).strict()),
  actionSchema('stage.goto_scene', z.object({ sceneId: identifierSchema }).strict()),
  actionSchema(
    'stage.highlight',
    z
      .object({
        sceneId: identifierSchema,
        elementId: identifierSchema,
        durationMs: z.number().int().positive().max(60_000).optional(),
        color: z.string().trim().min(1).max(64).optional(),
        style: z.enum(['outline', 'fill', 'shadow']).optional(),
      })
      .strict(),
  ),
  actionSchema(
    'stage.pointer',
    z
      .object({
        sceneId: identifierSchema,
        elementId: identifierSchema.optional(),
        x: z.number().min(0).max(1).optional(),
        y: z.number().min(0).max(1).optional(),
        durationMs: z.number().int().positive().max(60_000).optional(),
      })
      .strict(),
  ),
  actionSchema(
    'board.apply',
    z
      .object({
        whiteboardId: identifierSchema.optional(),
        operation: z.enum(['add', 'update', 'delete']),
        elementId: identifierSchema.optional(),
        element: z.record(z.string(), jsonValueSchema).optional(),
      })
      .strict(),
  ),
  actionSchema('board.clear', z.object({ whiteboardId: identifierSchema.optional() }).strict()),
  actionSchema(
    'avatar.expression',
    z
      .object({
        expression: z.enum(['neutral', 'relaxed', 'think', 'happy', 'surprised']),
        intensity: z.number().min(0).max(1).optional(),
      })
      .strict(),
  ),
  actionSchema('avatar.gesture', z.object({ gesture: identifierSchema }).strict()),
  actionSchema(
    'avatar.look_at',
    z.object({ target: z.enum(['student', 'slides', 'whiteboard', 'camera']) }).strict(),
  ),
  actionSchema(
    'avatar.speech_start',
    z.object({ text: z.string().trim().min(1).max(20_000) }).strict(),
  ),
  actionSchema('avatar.speech_end', emptyPayloadSchema),
  actionSchema('checkpoint.open', z.object({ checkpointId: identifierSchema }).strict()),
  actionSchema(
    'checkpoint.submit',
    z
      .object({
        checkpointId: identifierSchema,
        response: jsonValueSchema,
      })
      .strict(),
  ),
  actionSchema('checkpoint.close', z.object({ checkpointId: identifierSchema }).strict()),
  actionSchema(
    'source.show',
    z
      .object({
        sourceId: identifierSchema,
        page: z.number().int().positive().optional(),
      })
      .strict(),
  ),
]);

/**
 * 已成功结束的教师 speech 引用：成对的 `avatar.speech_start` /
 * `avatar.speech_end` 已提交动作 id。控制器校验二者都已提交且 end 在
 * start 之后，才承认 speech 成功结束。
 */
export const lessonCompletionSpeechRefSchema = z
  .object({
    startActionId: identifierSchema,
    endActionId: identifierSchema,
  })
  .strict();

export const LESSON_COMPLETION_EVENT_TYPE = 'lesson.complete_node' as const;

/**
 * 节点讲授完成的权威事件 `lesson.complete_node`
 * （docs/spec/04-detailed-design.md §1，A2 才新写——现有 schema 此前没有
 * 此事件，不是沿用）。类型化且幂等：携带稳定 idempotency key，
 * `classroomSessionId` / `courseId` / `lessonId` / `nodeId` 以及已成功结束的
 * speech / action 引用。只有教师 speech 与 action 都报告成功结束后，课堂
 * 控制器才可提交；媒体播放到达、加载回调与播放游标无权提交。该事件不创建
 * `EvidenceRecord`、不投影 `GoalState`、不表示掌握。
 */
export const lessonCompletionEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal(LESSON_COMPLETION_EVENT_TYPE),
    id: identifierSchema,
    /** 稳定 idempotency key：同一事件重试不重复推进 W / C。 */
    idempotencyKey: identifierSchema,
    classroomSessionId: identifierSchema,
    courseId: identifierSchema,
    lessonId: identifierSchema,
    nodeId: identifierSchema,
    speech: lessonCompletionSpeechRefSchema,
    /** 本节点已成功结束（已提交）的教师动作引用，至少一个。 */
    actionIds: z.array(identifierSchema).min(1),
    occurredAt: timestampSchema,
  })
  .strict();

export type LessonCompletionSpeechRef = z.infer<typeof lessonCompletionSpeechRefSchema>;
export type LessonCompletionEvent = z.infer<typeof lessonCompletionEventSchema>;

export type GoalRule = z.infer<typeof goalRuleSchema>;
export type LearningGoal = z.infer<typeof learningGoalSchema>;
export type AnticipatedQuestion = z.infer<typeof anticipatedQuestionSchema>;
export type LessonVisualAid = z.infer<typeof lessonVisualAidSchema>;
export type LessonNodeDesign = z.infer<typeof lessonNodeDesignSchema>;
export type LessonTeachingBrief = z.infer<typeof lessonTeachingBriefSchema>;
export type LessonNode = z.infer<typeof lessonNodeSchema>;
export type LessonPresentation = z.infer<typeof lessonPresentationSchema>;
export type LessonPlan = z.infer<typeof lessonPlanSchema>;
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
export type GoalState = z.infer<typeof goalStateSchema>;
export type TeachingAction = z.infer<typeof teachingActionSchema>;
export type TeachingActionType = TeachingAction['type'];
