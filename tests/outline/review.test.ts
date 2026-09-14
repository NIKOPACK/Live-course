import { describe, expect, test } from 'vitest';
import { repairOutlines, reviewOutlines } from '@/lib/livecourse/outline/review';
import type { SceneOutline } from '@/lib/types/generation';

function outline(id: string, title: string, order: number): SceneOutline {
  return { id, title, order, type: 'slide', description: `${title} 描述` } as SceneOutline;
}

const baseInput = {
  requirement: '我想学高数的极限部分',
  selectedTopics: ['极限与连续'],
  outlines: [outline('scene_1', '极限的概念', 0), outline('scene_2', '极限的计算', 1)],
};

describe('reviewOutlines', () => {
  test('解析 pass=true 的合格结论', async () => {
    const result = await reviewOutlines(baseInput, async () =>
      JSON.stringify({ pass: true, issues: [] }),
    );
    expect(result).toEqual({ pass: true, issues: [] });
  });

  test('解析 pass=false 并保留问题列表（sceneId 可选）', async () => {
    const result = await reviewOutlines(baseInput, async () =>
      JSON.stringify({
        pass: false,
        issues: [
          { sceneId: 'scene_2', problem: '测验排在内容之前', fix: '把测验移到最后' },
          { problem: '范围外内容', fix: '删除该场景' },
        ],
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toEqual({
      sceneId: 'scene_2',
      problem: '测验排在内容之前',
      fix: '把测验移到最后',
    });
    expect(result.issues[1].sceneId).toBeUndefined();
  });

  test('LLM 报错时放行原大纲（pass open）', async () => {
    const result = await reviewOutlines(baseInput, async () => {
      throw new Error('model unavailable');
    });
    expect(result).toEqual({ pass: true, issues: [] });
  });

  test('输出无法解析 / 形状不合法时放行', async () => {
    for (const bad of ['not json at all', JSON.stringify({ verdict: 'ok' }), JSON.stringify([])]) {
      const result = await reviewOutlines(baseInput, async () => bad);
      expect(result).toEqual({ pass: true, issues: [] });
    }
  });

  test('prompt 带勾选范围约束', async () => {
    let seenUser = '';
    await reviewOutlines(baseInput, async (_system, user) => {
      seenUser = user;
      return JSON.stringify({ pass: true, issues: [] });
    });
    expect(seenUser).toContain('极限与连续');
    expect(seenUser).toContain('scene_1');
  });
});

describe('repairOutlines', () => {
  const issues = [{ sceneId: 'scene_2', problem: '顺序错误', fix: '与 scene_1 交换' }];

  test('返回修复后的完整大纲数组', async () => {
    const repaired = [outline('scene_1', '极限的计算', 0), outline('scene_2', '极限的概念', 1)];
    const result = await repairOutlines({ ...baseInput, issues }, async () =>
      JSON.stringify(repaired),
    );
    expect(result.map((o) => o.id)).toEqual(['scene_1', 'scene_2']);
    expect(result[0].title).toBe('极限的计算');
  });

  test('兼容 { outlines: [...] } 包裹形式', async () => {
    const repaired = [outline('scene_1', '极限的概念', 0)];
    const result = await repairOutlines({ ...baseInput, issues }, async () =>
      JSON.stringify({ outlines: repaired }),
    );
    expect(result).toHaveLength(1);
  });

  test('修复输出不可用（坏 JSON / 空数组 / 无 title）时保留原大纲', async () => {
    for (const bad of [
      'garbage',
      JSON.stringify([]),
      JSON.stringify([{ id: 'x' }]), // 无 title 的条目全部无效
    ]) {
      const result = await repairOutlines({ ...baseInput, issues }, async () => bad);
      expect(result).toBe(baseInput.outlines);
    }
  });

  test('LLM 报错时保留原大纲', async () => {
    const result = await repairOutlines({ ...baseInput, issues }, async () => {
      throw new Error('model unavailable');
    });
    expect(result).toBe(baseInput.outlines);
  });
});
