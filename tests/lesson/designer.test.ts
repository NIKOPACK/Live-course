import { describe, expect, test, vi } from 'vitest';
import {
  designLessonPlan,
  designLessonPlanWithSubagents,
  formatLessonNodeDesignForPrompt,
  type DesignLessonPlanInput,
  type LessonSubagentPoolExecutor,
} from '@/lib/livecourse/lesson/designer';
import type { SubagentRuntime } from '@/lib/livecourse/outline/subagent';
import { lessonPlanSchema, type LessonNodeDesign } from '@/lib/livecourse/domain/schemas';
import { goalIdForScene, nodeIdForScene } from '@/lib/livecourse/domain/lesson-plan';
import type { SceneOutline } from '@/lib/types/generation';

const NOW = '2026-08-20T00:00:00.000Z';

const outlines: SceneOutline[] = [
  {
    id: 'scene-intro',
    type: 'slide',
    title: '导数引入',
    description: '从瞬时速度引入导数概念',
    keyPoints: ['瞬时速度', '割线与切线'],
    order: 0,
  },
  {
    id: 'scene-check',
    type: 'quiz',
    title: '导数概念检查',
    description: '检查导数定义理解',
    keyPoints: ['导数定义'],
    order: 1,
  },
  {
    id: 'scene-lab',
    type: 'interactive',
    title: '切线斜率实验',
    description: '拖动点观察割线逼近切线',
    keyPoints: ['极限直观'],
    order: 2,
  },
];

function designFor(suffix: string): LessonNodeDesign {
  return {
    teachingPoints: [`要点一 ${suffix}`, `要点二 ${suffix}`],
    explanationPlan: `先用生活例子引入，再展开定义，最后小结 ${suffix}`,
    examples: [`例子 ${suffix}`],
    anticipatedQuestions: [{ question: `学生问 ${suffix}？`, response: `预设回应 ${suffix}` }],
    misconceptions: [`易错点 ${suffix}`],
  };
}

function llmPayload(ids: string[] = outlines.map((o) => o.id)): string {
  return JSON.stringify({
    nodes: ids.map((id) => ({ sceneId: id, design: designFor(id) })),
  });
}

function input(overrides: Partial<DesignLessonPlanInput> = {}): DesignLessonPlanInput {
  return {
    stageId: 'stage-abc',
    requirement: '用中文给我讲一节课：导数的概念，面向高中生',
    courseTitle: '导数的概念',
    languageDirective: '请使用简体中文',
    outlines,
    now: NOW,
    ...overrides,
  };
}

describe('designLessonPlan', () => {
  test('保留显式 courseId/stageId 身份，旧调用仍以 stageId 兼容', async () => {
    const plan = await designLessonPlan(
      input({ courseId: 'course-stable', lessonId: 'lesson-stable' }),
      async () => llmPayload(),
    );

    expect(plan).not.toBeNull();
    expect(plan!.id).toBe('lesson-plan:course-stable');
    expect(plan!.courseId).toBe('course-stable');
    expect(plan!.stageId).toBe('stage-abc');
  });

  test('正常产出：组装出通过 lessonPlanSchema 校验的教案，design 按 sceneId 落到节点', async () => {
    const plan = await designLessonPlan(input(), async () => llmPayload());

    expect(plan).not.toBeNull();
    expect(() => lessonPlanSchema.parse(plan)).not.toThrow();

    expect(plan!.id).toBe('lesson-plan:stage-abc');
    expect(plan!.courseId).toBe('stage-abc');
    expect(plan!.stageId).toBe('stage-abc');
    expect(plan!.title).toBe('导数的概念');
    expect(plan!.createdAt).toBe(NOW);
    expect(plan!.nodes).toHaveLength(3);
    expect(plan!.nodes.map((n) => n.design?.teachingPoints[0])).toEqual([
      '要点一 scene-intro',
      '要点一 scene-check',
      '要点一 scene-lab',
    ]);
  });

  test('goals/nodes ID 与 deriveLessonPlanFromStage 约定一致', async () => {
    const plan = await designLessonPlan(input(), async () => llmPayload());

    // quiz 场景产出掌握目标，ID 沿用 goalIdForScene 约定
    expect(plan!.goals.map((g) => g.id)).toEqual([goalIdForScene('scene-check')]);
    expect(plan!.goals[0].rule).toEqual({
      version: 'livecourse-quiz-mastery-v1',
      passScore: 0.7,
      minAcceptedEvidence: 1,
      minPassingEvidence: 1,
    });

    const [intro, check, lab] = plan!.nodes;
    expect(intro.id).toBe(nodeIdForScene('scene-intro'));
    expect(intro.sceneId).toBe('scene-intro');
    expect(intro.type).toBe('instruction');
    expect(intro.order).toBe(0);
    // 非 quiz 节点没有自己的 goal；fallback goal 不存在时 goalIds 为空（同 derive）
    expect(intro.goalIds).toEqual([]);

    expect(check.id).toBe(nodeIdForScene('scene-check'));
    expect(check.type).toBe('checkpoint');
    expect(check.goalIds).toEqual([goalIdForScene('scene-check')]);

    expect(lab.type).toBe('interactive');
    expect(lab.goalIds).toEqual([]);
  });

  test('无 quiz 大纲时回退单一目标 goal:<stageId>:lesson，所有节点引用它', async () => {
    const slideOnly = outlines.filter((o) => o.type !== 'quiz');
    const plan = await designLessonPlan(input({ outlines: slideOnly }), async () =>
      llmPayload(slideOnly.map((o) => o.id)),
    );

    expect(plan!.goals.map((g) => g.id)).toEqual(['goal:stage-abc:lesson']);
    expect(plan!.nodes.every((n) => n.goalIds.join() === 'goal:stage-abc:lesson')).toBe(true);
  });

  test('某节点缺 teachingPoints 返回 null', async () => {
    const payload = JSON.stringify({
      nodes: [
        { sceneId: 'scene-intro', design: designFor('a') },
        {
          sceneId: 'scene-check',
          design: { explanationPlan: '没有要点，只有讲解组织' },
        },
        { sceneId: 'scene-lab', design: designFor('c') },
      ],
    });

    const plan = await designLessonPlan(input(), async () => payload);
    expect(plan).toBeNull();
  });

  test('LLM 漏掉某个节点返回 null', async () => {
    const plan = await designLessonPlan(input(), async () =>
      llmPayload(['scene-intro', 'scene-check']),
    );
    expect(plan).toBeNull();
  });

  test('垃圾输出返回 null', async () => {
    for (const garbage of ['not json at all', '{"nodes": "nope"}', '{"nodes": []}', '{"foo": 1}']) {
      const plan = await designLessonPlan(input(), async () => garbage);
      expect(plan).toBeNull();
    }
  });

  test('LLM 调用抛错返回 null', async () => {
    const plan = await designLessonPlan(input(), async () => {
      throw new Error('model unavailable');
    });
    expect(plan).toBeNull();
  });

  test('design 带多余字段（strict schema）返回 null', async () => {
    const payload = JSON.stringify({
      nodes: outlines.map((o) => ({
        sceneId: o.id,
        design: { ...designFor(o.id), unexpected: 'field' },
      })),
    });
    const plan = await designLessonPlan(input(), async () => payload);
    expect(plan).toBeNull();
  });

  test('markdown 围栏包裹的 JSON 也能修复解析', async () => {
    const plan = await designLessonPlan(input(), async () => `\`\`\`json\n${llmPayload()}\n\`\`\``);
    expect(plan).not.toBeNull();
    expect(plan!.nodes).toHaveLength(3);
  });
});

describe('designLessonPlanWithSubagents', () => {
  // 5 个节点，触发 fan-out（阈值 SUBAGENT_FAN_OUT_MIN_NODES = 4）
  const manyOutlines: SceneOutline[] = [
    ...outlines,
    {
      id: 'scene-rules',
      type: 'slide',
      title: '求导法则',
      description: '四则运算求导法则',
      keyPoints: ['和差积商求导'],
      order: 3,
    },
    {
      id: 'scene-quiz-2',
      type: 'quiz',
      title: '求导法则检查',
      description: '检查求导法则应用',
      keyPoints: ['法则应用'],
      order: 4,
    },
  ];

  // pool 执行器被注入替代，runtime 不会真正用到，给个占位对象即可
  const fakeRuntime = { languageModel: {} } as unknown as SubagentRuntime;

  function poolReturning(designsByName: Map<string, string>, failed: string[] = []) {
    const executor: LessonSubagentPoolExecutor = vi.fn(async () => ({
      outputs: designsByName,
      failed,
    }));
    return executor;
  }

  test('≤3 个节点直接走单调用，不 fan-out', async () => {
    const poolExecutor: LessonSubagentPoolExecutor = vi.fn(async () => {
      throw new Error('pool should not be used for small lessons');
    });
    const aiCall = vi.fn(async () => llmPayload());

    const plan = await designLessonPlanWithSubagents(input(), fakeRuntime, aiCall, poolExecutor);

    expect(poolExecutor).not.toHaveBeenCalled();
    expect(aiCall).toHaveBeenCalledTimes(1);
    expect(plan).not.toBeNull();
    expect(plan!.nodes).toHaveLength(3);
  });

  test('fan-out 正常：每节点一个 lesson-node:<sceneId> subagent，design 按 sceneId 组装', async () => {
    const outputs = new Map(
      manyOutlines.map((o) => [`lesson-node:${o.id}`, JSON.stringify(designFor(o.id))]),
    );
    const poolExecutor = poolReturning(outputs);
    const aiCall = vi.fn(async () => {
      throw new Error('single call should not be needed');
    });

    const plan = await designLessonPlanWithSubagents(
      input({ outlines: manyOutlines }),
      fakeRuntime,
      aiCall,
      poolExecutor,
    );

    expect(poolExecutor).toHaveBeenCalledTimes(1);
    const tasks = vi.mocked(poolExecutor).mock.calls[0][0];
    expect(tasks.map((t) => t.name)).toEqual(manyOutlines.map((o) => `lesson-node:${o.id}`));
    // 任务正文含本节点大纲与前后节点标题（衔接不重复）
    const rulesTask = tasks.find((t) => t.name === 'lesson-node:scene-rules')!;
    expect(rulesTask.task).toContain('求导法则');
    expect(rulesTask.task).toContain('切线斜率实验');
    expect(rulesTask.task).toContain('求导法则检查');

    expect(aiCall).not.toHaveBeenCalled();
    expect(plan).not.toBeNull();
    expect(() => lessonPlanSchema.parse(plan)).not.toThrow();
    expect(plan!.nodes.map((n) => n.design?.teachingPoints[0])).toEqual(
      manyOutlines.map((o) => `要点一 ${o.id}`),
    );
  });

  test('部分 subagent 失败：用一次单调用补齐缺失节点', async () => {
    const okIds = ['scene-intro', 'scene-check', 'scene-lab'];
    const outputs = new Map(
      okIds.map((id) => [`lesson-node:${id}`, JSON.stringify(designFor(id))]),
    );
    const poolExecutor = poolReturning(outputs, [
      'lesson-node:scene-rules',
      'lesson-node:scene-quiz-2',
    ]);
    const aiCall = vi.fn(async (_system: string, _user: string) =>
      llmPayload(['scene-rules', 'scene-quiz-2']),
    );

    const plan = await designLessonPlanWithSubagents(
      input({ outlines: manyOutlines }),
      fakeRuntime,
      aiCall,
      poolExecutor,
    );

    expect(aiCall).toHaveBeenCalledTimes(1);
    // 补充调用的 user prompt 只包含缺失节点
    expect(aiCall.mock.calls[0][1]).toContain('scene-rules');
    expect(aiCall.mock.calls[0][1]).toContain('scene-quiz-2');
    expect(aiCall.mock.calls[0][1]).not.toContain('scene-intro');

    expect(plan).not.toBeNull();
    expect(plan!.nodes).toHaveLength(5);
    expect(plan!.nodes.every((n) => n.design)).toBe(true);
  });

  test('subagent 输出不合格也按失败节点处理，走单调用补齐', async () => {
    const outputs = new Map(
      manyOutlines.map((o) => [`lesson-node:${o.id}`, JSON.stringify(designFor(o.id))]),
    );
    outputs.set('lesson-node:scene-lab', '{"teachingPoints": []}');
    const poolExecutor = poolReturning(outputs);
    const aiCall = vi.fn(async () => llmPayload(['scene-lab']));

    const plan = await designLessonPlanWithSubagents(
      input({ outlines: manyOutlines }),
      fakeRuntime,
      aiCall,
      poolExecutor,
    );

    expect(aiCall).toHaveBeenCalledTimes(1);
    expect(plan!.nodes.find((n) => n.sceneId === 'scene-lab')!.design).toBeDefined();
  });

  test('全部失败且单调用补充也失败：节点保留但无 design（固定降级语义）', async () => {
    // 语义固定：fan-out 全灭 + 补充单调用失败时不丢整份教案骨架，
    // 节点全部保留、design 省略（lessonNodeSchema.design 可选），
    // 内容生成端按无教案节点照常只读大纲。
    const poolExecutor = poolReturning(
      new Map(),
      manyOutlines.map((o) => `lesson-node:${o.id}`),
    );
    const aiCall = vi.fn(async () => {
      throw new Error('model unavailable');
    });

    const plan = await designLessonPlanWithSubagents(
      input({ outlines: manyOutlines }),
      fakeRuntime,
      aiCall,
      poolExecutor,
    );

    expect(plan).not.toBeNull();
    expect(() => lessonPlanSchema.parse(plan)).not.toThrow();
    expect(plan!.nodes.map((n) => n.sceneId)).toEqual(manyOutlines.map((o) => o.id));
    expect(plan!.nodes.every((n) => n.design === undefined)).toBe(true);
  });

  test('客户端断开时不再打补充单调用，并把 AbortError 抛给路由', async () => {
    const controller = new AbortController();
    controller.abort();
    const poolExecutor = poolReturning(
      new Map(),
      manyOutlines.map((o) => `lesson-node:${o.id}`),
    );
    const aiCall = vi.fn(async () => {
      throw new Error('fallback should not run after abort');
    });

    await expect(
      designLessonPlanWithSubagents(
        input({ outlines: manyOutlines }),
        { ...fakeRuntime, abortSignal: controller.signal },
        aiCall,
        poolExecutor,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(aiCall).not.toHaveBeenCalled();
  });

  test('整体 schema 校验失败返回 null（与单调用同语义）', async () => {
    // title 超长（max 500）触发 lessonPlanSchema.parse 抛错
    const outputs = new Map(
      manyOutlines.map((o) => [`lesson-node:${o.id}`, JSON.stringify(designFor(o.id))]),
    );
    const plan = await designLessonPlanWithSubagents(
      input({ outlines: manyOutlines, courseTitle: '长'.repeat(600) }),
      fakeRuntime,
      async () => llmPayload(),
      poolReturning(outputs),
    );
    expect(plan).toBeNull();
  });
});

describe('formatLessonNodeDesignForPrompt', () => {
  test('无设计返回空串', () => {
    expect(formatLessonNodeDesignForPrompt(undefined)).toBe('');
  });

  test('包含讲授要点、讲解组织、预设提问与回应、易错点', () => {
    const text = formatLessonNodeDesignForPrompt(designFor('x'));
    expect(text).toContain("This Scene's Lesson Design");
    expect(text).toContain('1. 要点一 x');
    expect(text).toContain('讲解组织');
    expect(text).toContain('Q: 学生问 x？');
    expect(text).toContain('A: 预设回应 x');
    expect(text).toContain('易错点');
  });

  test('A5：包含配图设计占位 id 与用途；无配图时不出现该段', () => {
    const withAids = formatLessonNodeDesignForPrompt({
      ...designFor('y'),
      visualAids: [
        {
          id: 'lesson_img_scene-intro_1',
          prompt: '水循环示意图，所有标注为中文',
          purpose: '建立整体图景',
          aspectRatio: '4:3',
        },
      ],
    });
    expect(withAids).toContain('配图设计');
    expect(withAids).toContain('lesson_img_scene-intro_1');
    expect(withAids).toContain('purpose: 建立整体图景');
    expect(withAids).toContain('aspect ratio: 4:3');
    expect(formatLessonNodeDesignForPrompt(designFor('y'))).not.toContain('配图设计');
  });
});
