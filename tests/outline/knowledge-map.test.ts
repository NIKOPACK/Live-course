import { describe, expect, test } from 'vitest';
import {
  normalizeKnowledgeMap,
  runKnowledgeMapper,
  runKnowledgeMapperWithSubagents,
} from '@/lib/livecourse/outline/knowledge-map';
import type {
  SubagentPoolResult,
  SubagentRuntime,
  SubagentTask,
} from '@/lib/livecourse/outline/subagent';
import type { ClarifyAnswer } from '@/lib/livecourse/outline/types';

const knowledgeMapJson = JSON.stringify({
  subject: '高等数学（大一上）',
  topics: [
    {
      id: 'limits',
      title: '极限与连续',
      summary: '数列与函数极限、连续性判定',
      recommended: true,
      children: [
        {
          id: 'epsilon_delta',
          title: '极限的严格定义',
          summary: 'ε-δ 语言',
          recommended: false,
        },
      ],
    },
    { id: 'diff', title: '一元微分', summary: '导数与微分法则', recommended: true },
    { id: 'series', title: '级数', summary: '收敛与发散', recommended: false },
  ],
});

describe('runKnowledgeMapper', () => {
  test('parses a two-level topic tree', async () => {
    const result = await runKnowledgeMapper('我想学高数', undefined, async () => knowledgeMapJson);

    expect(result.subject).toBe('高等数学（大一上）');
    expect(result.topics).toHaveLength(3);
    expect(result.topics[0].children).toHaveLength(1);
    expect(result.topics[0].children![0].recommended).toBe(false);
    expect(result.topics.filter((t) => t.recommended).map((t) => t.id)).toEqual(['limits', 'diff']);
  });

  test('forwards clarification answers into the user prompt', async () => {
    const answers: ClarifyAnswer[] = [
      {
        questionId: 'q1',
        question: '你想覆盖哪些部分？',
        selectedOptionIds: ['limits'],
        selectedLabels: ['极限与连续'],
      },
    ];
    let seenUser = '';
    await runKnowledgeMapper('我想学高数', answers, async (_system, user) => {
      seenUser = user;
      return knowledgeMapJson;
    });

    expect(seenUser).toContain('极限与连续');
    expect(seenUser).toContain('你想覆盖哪些部分？');
  });

  test('degrades to empty topics on garbage output', async () => {
    const result = await runKnowledgeMapper('我想学高数', undefined, async () => '不是 JSON');

    expect(result).toEqual({ subject: '我想学高数', topics: [] });
  });

  test('degrades to empty topics when aiCall throws', async () => {
    const result = await runKnowledgeMapper('教我物理学电磁学', undefined, async () => {
      throw new Error('upstream down');
    });

    expect(result).toEqual({ subject: '教我物理学电磁学', topics: [] });
  });

  test('truncates the degraded subject to 30 chars', async () => {
    const long = '学'.repeat(50);
    const result = await runKnowledgeMapper(long, undefined, async () => 'garbage');
    expect(result.subject).toHaveLength(30);
  });
});

describe('normalizeKnowledgeMap', () => {
  test('rejects missing subject or non-array topics', () => {
    expect(normalizeKnowledgeMap(null)).toBeNull();
    expect(normalizeKnowledgeMap({ topics: [] })).toBeNull();
    expect(normalizeKnowledgeMap({ subject: 'x', topics: 'nope' })).toBeNull();
  });

  test('drops topics without title and fills missing ids', () => {
    const result = normalizeKnowledgeMap({
      subject: '  物理  ',
      topics: [{ summary: '没有标题' }, { title: '力学', recommended: 'yes', summary: 42 }],
    });

    expect(result).not.toBeNull();
    expect(result!.subject).toBe('物理');
    expect(result!.topics).toHaveLength(1);
    expect(result!.topics[0].id).toBe('topic_2');
    expect(result!.topics[0].recommended).toBe(false);
    expect(result!.topics[0].summary).toBeUndefined();
  });
});

describe('runKnowledgeMapperWithSubagents', () => {
  // 注入的 pool 不触碰 runtime，测试里给空壳即可
  const runtime = {} as SubagentRuntime;

  const branchesJson = JSON.stringify({
    subject: '高等数学（大一上）',
    branches: [
      { id: 'limits', title: '极限与连续', summary: '数列与函数极限、连续性' },
      { id: 'diff', title: '一元微分', summary: '导数与微分法则' },
      { id: 'integral', title: '一元积分', summary: '不定积分与定积分' },
    ],
  });

  /** 按枝干名给出细分输出的 pool 工厂；failures 里的名字记为失败。 */
  function fakePool(outputsByBranchTitle: Record<string, string>, failures: string[] = []) {
    return async (tasks: SubagentTask[]): Promise<SubagentPoolResult> => {
      const outputs = new Map<string, string>();
      const failed: string[] = [];
      for (const task of tasks) {
        const title = task.name.replace('knowledge-branch:', '');
        if (failures.includes(title)) {
          failed.push(task.name);
        } else if (outputsByBranchTitle[title] !== undefined) {
          outputs.set(task.name, outputsByBranchTitle[title]);
        } else {
          failed.push(task.name);
        }
      }
      return { outputs, failed };
    };
  }

  const limitsSubtopics = JSON.stringify([
    { id: 'epsilon_delta', title: '极限的严格定义', summary: 'ε-δ 语言', recommended: true },
    { id: 'continuity', title: '连续性判定', summary: '连续与间断点', recommended: true },
  ]);
  const diffSubtopics = JSON.stringify([
    { id: 'derivative_rules', title: '求导法则', summary: '四则与链式法则', recommended: true },
  ]);

  test('merges branch subagents into a two-level tree', async () => {
    let seenTasks: SubagentTask[] = [];
    const pool = async (tasks: SubagentTask[]): Promise<SubagentPoolResult> => {
      seenTasks = tasks;
      return fakePool({
        极限与连续: limitsSubtopics,
        一元微分: diffSubtopics,
        一元积分: JSON.stringify([
          {
            id: 'newton_leibniz',
            title: '牛顿-莱布尼茨公式',
            summary: '定积分计算',
            recommended: false,
          },
        ]),
      })(tasks);
    };

    const result = await runKnowledgeMapperWithSubagents(
      '我想学高数',
      undefined,
      runtime,
      async () => branchesJson,
      pool,
    );

    expect(result.subject).toBe('高等数学（大一上）');
    expect(result.topics).toHaveLength(3);
    expect(result.topics.map((t) => t.id)).toEqual(['limits', 'diff', 'integral']);
    // 枝干为父节点，细分子主题为 children
    expect(result.topics[0].children!.map((c) => c.id)).toEqual(['epsilon_delta', 'continuity']);
    expect(result.topics[1].children).toHaveLength(1);
    // 父节点不标 recommended，叶子携带 recommended
    expect(result.topics[0].recommended).toBe(false);
    expect(result.topics[0].children![0].recommended).toBe(true);
    // 每个枝干派了一个 subagent，name 用 knowledge-branch:<title>
    expect(seenTasks.map((t) => t.name)).toEqual([
      'knowledge-branch:极限与连续',
      'knowledge-branch:一元微分',
      'knowledge-branch:一元积分',
    ]);
    // 细分 prompt 不越界：任务文本带有枝干边界信息
    expect(seenTasks[0].task).toContain('一元微分');
    expect(seenTasks[0].task).toContain('Your branch: "极限与连续"');
  });

  test('falls back to single-call mapper when one branch subagent fails', async () => {
    let calls = 0;
    const result = await runKnowledgeMapperWithSubagents(
      '我想学高数',
      undefined,
      runtime,
      async () => {
        calls += 1;
        return calls === 1 ? branchesJson : knowledgeMapJson;
      },
      fakePool({ 极限与连续: limitsSubtopics, 一元微分: diffSubtopics }, ['一元积分']),
    );

    expect(calls).toBe(2);
    expect(result).toEqual(normalizeKnowledgeMap(JSON.parse(knowledgeMapJson)));
  });

  test('falls back to single-call mapper when branch output is unparseable', async () => {
    let calls = 0;
    const result = await runKnowledgeMapperWithSubagents(
      '我想学高数',
      undefined,
      runtime,
      async () => {
        calls += 1;
        return calls === 1 ? branchesJson : knowledgeMapJson;
      },
      fakePool({
        极限与连续: limitsSubtopics,
        一元微分: diffSubtopics,
        一元积分: '这不是 JSON',
      }),
    );

    expect(calls).toBe(2);
    expect(result).toEqual(normalizeKnowledgeMap(JSON.parse(knowledgeMapJson)));
  });

  test('falls back to the single-call mapper when phase 1 fails', async () => {
    let calls = 0;
    const result = await runKnowledgeMapperWithSubagents(
      '我想学高数',
      undefined,
      runtime,
      async () => {
        calls += 1;
        // 第一次（Phase 1 粗分）给垃圾，第二次（单调用降级）给完整知识树
        return calls === 1 ? '不是 JSON' : knowledgeMapJson;
      },
      async () => {
        throw new Error('pool must not run when phase 1 fails');
      },
    );

    expect(calls).toBe(2);
    expect(result.subject).toBe('高等数学（大一上）');
    expect(result.topics.map((t) => t.id)).toEqual(['limits', 'diff', 'series']);
  });

  test('falls back to the single-call mapper when all branch subagents fail', async () => {
    let calls = 0;
    const result = await runKnowledgeMapperWithSubagents(
      '我想学高数',
      undefined,
      runtime,
      async () => {
        calls += 1;
        return calls === 1 ? branchesJson : knowledgeMapJson;
      },
      fakePool({}, ['极限与连续', '一元微分', '一元积分']),
    );

    expect(calls).toBe(2);
    expect(result.topics.map((t) => t.id)).toEqual(['limits', 'diff', 'series']);
  });

  test('caps recommended leaves at 15, keeping the nodes themselves', async () => {
    // 5 个枝干 × 4 个 recommended = 20 个 recommended 叶子，超出上限
    const fiveBranches = JSON.stringify({
      subject: '大学物理',
      branches: ['力学', '热学', '电磁学', '光学', '近代物理'].map((title, i) => ({
        id: `branch_${i + 1}`,
        title,
        summary: `${title}概要`,
      })),
    });
    const fourRecommended = JSON.stringify(
      [1, 2, 3, 4].map((n) => ({
        id: `sub_${n}`,
        title: `子主题${n}`,
        summary: '说明',
        recommended: true,
      })),
    );

    const result = await runKnowledgeMapperWithSubagents(
      '我想学大学物理',
      undefined,
      runtime,
      async () => fiveBranches,
      fakePool({
        力学: fourRecommended,
        热学: fourRecommended,
        电磁学: fourRecommended,
        光学: fourRecommended,
        近代物理: fourRecommended,
      }),
    );

    const recommendedLeaves = result.topics.flatMap((t) =>
      (t.children ?? [t]).filter((leaf) => leaf.recommended),
    );
    expect(recommendedLeaves).toHaveLength(15);
    // 节点本身保留：每枝干仍是 4 个子主题
    for (const topic of result.topics) {
      expect(topic.children).toHaveLength(4);
    }
    // 按顺序截断：前三个枝干全 recommended，第四个枝干只有前 3 个
    expect(result.topics[2].children!.every((c) => c.recommended)).toBe(true);
    expect(result.topics[3].children!.map((c) => c.recommended)).toEqual([true, true, true, false]);
    expect(result.topics[4].children!.every((c) => !c.recommended)).toBe(true);
  });
});
