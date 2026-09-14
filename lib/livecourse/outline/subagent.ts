/**
 * Worker Agent 的 subagent 运行器（docs/spec/04-detailed-design.md §7，才新写 A4）。
 *
 * 生成侧的 worker（知识分解、教案设计……）通过这里派生并行 subagent。
 * 运行时沿用 `@earendil-works/pi-agent-core`（课堂 director 同款 pi harness），
 * LLM 调用走 LiveCourse 已解析的模型连接器，不新增 provider 路径。
 *
 * 约束（规格）：subagent 是台后 worker，不在学习者界面出现身份；
 * 并发有上限；任何 subagent 失败由调用方降级，本模块自身只如实抛错。
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { LanguageModel } from 'ai';
import { buildAgent } from '@/lib/agent/runtime/build-agent';
import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';
import type { ThinkingConfig } from '@/lib/types/provider';
import { createLogger } from '@/lib/logger';

const log = createLogger('OutlineSubagent');

export interface SubagentRuntime {
  /** resolveModelFromRequest 解析出的模型实例 */
  languageModel: LanguageModel;
  thinkingConfig?: ThinkingConfig;
  abortSignal?: AbortSignal;
}

export interface SubagentTask {
  /** 日志用名字，如 'knowledge-branch:极限与连续' */
  name: string;
  systemPrompt: string;
  task: string;
  maxOutputTokens?: number;
}

/** 从 pi 消息历史取最后一条 assistant 文本（本地实现，避免耦合课堂 director 的 prompts）。 */
function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (part): part is { type: 'text'; text: string } =>
            !!part && typeof part === 'object' && (part as { type?: string }).type === 'text',
        )
        .map((part) => part.text)
        .join('');
      if (text.trim()) return text;
    }
  }
  return '';
}

/**
 * 跑一个 subagent，返回其最终文本输出。失败抛错——降级策略由调用方决定。
 * subagent 无工具（空 allowlist）：它只做「基于自己上下文产出文本」这一件事。
 */
export async function runSubagent(task: SubagentTask, runtime: SubagentRuntime): Promise<string> {
  const agent = buildAgent({
    streamFn: createCallLlmStreamFn({
      languageModel: runtime.languageModel,
      thinkingConfig: runtime.thinkingConfig,
      maxOutputTokens: task.maxOutputTokens,
      source: `outline-subagent:${task.name}`,
      abortSignal: runtime.abortSignal,
    }),
    systemPrompt: task.systemPrompt,
    tools: [],
    allowedToolNames: new Set<string>(),
  });
  await agent.prompt(task.task);
  const text = lastAssistantText(agent.state.messages);
  if (!text.trim()) {
    throw new Error(`Subagent "${task.name}" returned empty output`);
  }
  return text;
}

export interface SubagentPoolOptions {
  /** 并发上限，默认 4（规格 §7：并发有上限） */
  concurrency?: number;
}

export interface SubagentPoolResult {
  /** name → 成功输出 */
  outputs: Map<string, string>;
  /** 失败的 subagent 名（调用方据此降级） */
  failed: string[];
}

/**
 * 并行跑一组 subagent，带并发上限。单个失败不拖垮整池：
 * 记入 failed，由调用方决定整体降级还是部分合并。
 */
export async function runSubagentPool(
  tasks: SubagentTask[],
  runtime: SubagentRuntime,
  options?: SubagentPoolOptions,
): Promise<SubagentPoolResult> {
  const concurrency = Math.max(1, options?.concurrency ?? 4);
  const outputs = new Map<string, string>();
  const failed: string[] = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < tasks.length) {
      if (runtime.abortSignal?.aborted) break;
      const task = tasks[cursor];
      cursor += 1;
      try {
        outputs.set(task.name, await runSubagent(task, runtime));
      } catch (error) {
        log.warn(`Subagent "${task.name}" failed:`, error);
        failed.push(task.name);
        if (runtime.abortSignal?.aborted) break;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return { outputs, failed };
}
