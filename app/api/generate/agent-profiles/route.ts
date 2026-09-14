/**
 * Agent Profiles Generation API
 *
 * Generates a single teacher profile for a course stage based on stage info
 * and scene outlines. Assistant / student profiles are not generated.
 */

import { NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { AGENT_COLOR_PALETTE } from '@/lib/constants/agent-defaults';
import { normalizeVoiceDesign } from '@/lib/audio/voice-design';

const log = createLogger('Agent Profiles API');

export const maxDuration = 120;

interface RequestBody {
  stageInfo: { name: string; description?: string };
  sceneOutlines?: { title: string; description?: string }[];
  languageDirective: string;
  availableAvatars: string[];
  avatarDescriptions?: Array<{ path: string; desc: string }>;
  availableVoices?: Array<{
    providerId: string;
    voiceId: string;
    voiceName: string;
    voiceLanguage?: string;
  }>;
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  // Remove markdown code fences (```json ... ``` or ``` ... ```)
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

export async function POST(req: NextRequest) {
  let stageName: string | undefined;
  let modelString: string | undefined;
  try {
    const body = (await req.json()) as RequestBody;
    const {
      stageInfo,
      sceneOutlines,
      languageDirective,
      availableAvatars,
      avatarDescriptions,
      availableVoices,
    } = body;
    stageName = stageInfo?.name;

    // ── Validate required fields ──
    if (!stageInfo?.name) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageInfo.name is required');
    }
    if (!languageDirective) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'languageDirective is required');
    }
    if (!availableAvatars || availableAvatars.length === 0) {
      return apiError(
        'MISSING_REQUIRED_FIELD',
        400,
        'availableAvatars is required and must not be empty',
      );
    }

    // ── Model resolution from request headers/body ──
    const {
      model: languageModel,
      modelString: _modelString,
      thinkingConfig,
    } = await resolveModelFromRequest(req, body, 'agent-profiles');
    modelString = _modelString;

    // ── Build prompt ──
    const sceneSummary = sceneOutlines?.length
      ? sceneOutlines
          .map((s, i) => `${i + 1}. ${s.title}${s.description ? ` — ${s.description}` : ''}`)
          .join('\n')
      : null;

    const systemPrompt = `You are an expert instructional designer. Generate exactly one teacher profile for a self-paced classroom. Do not generate assistant or student agents. Return ONLY valid JSON, no markdown or explanation.`;

    // Build voice list for prompt (if available)
    const voiceListStr =
      availableVoices && availableVoices.length > 0
        ? JSON.stringify(
            availableVoices.map((v) => ({
              id: `${v.providerId}::${v.voiceId}`,
              name: v.voiceName,
              language: v.voiceLanguage || 'unknown',
            })),
          )
        : '';

    const voicePrompt = voiceListStr
      ? `- Each agent should be assigned a voice that matches their persona from this list: ${voiceListStr}
  - Prefer a voice whose language matches the course language directive
  - Pick a voice that suits the teacher's personality and role (e.g. an authoritative, clear teaching voice)`
      : '';

    const voiceJsonField = voiceListStr
      ? ',\n      "voice": "string (voice id from available list, e.g. \'qwen-tts::Cherry\')"'
      : '';

    const userPrompt = `Generate agent profiles for the following course:

Course name: ${stageInfo.name}
${stageInfo.description ? `Course description: ${stageInfo.description}` : ''}
${sceneSummary ? `\nScene outlines:\n${sceneSummary}\n` : ''}
Requirements:
- Generate exactly 1 agent with role "teacher". Do not generate assistant or student agents.
- Priority value: teacher=10
- The teacher needs: name, role, persona (2-3 sentences describing personality and teaching style)
- Language directive for this course: ${languageDirective}
  Agent names and personas must follow this language directive.
- The teacher must be assigned one avatar from this list: ${JSON.stringify(avatarDescriptions && avatarDescriptions.length > 0 ? avatarDescriptions.map((a) => ({ path: a.path, description: a.desc })) : availableAvatars)}
  - Pick an avatar that visually matches the teacher's personality and role
  - Use the "path" value as the avatar field in the output
- The teacher must be assigned one color from this list: ${JSON.stringify(AGENT_COLOR_PALETTE)}
- The teacher needs a "voiceDesign" object describing their VOCAL identity (not personality), written following the language directive and consistent with the persona, as three short comma-free phrases:
  - "identity": gender + age + role (e.g. "middle-aged male teacher")
  - "texture": pitch + vocal quality (e.g. "warm low-pitched slightly husky")
  - "delivery": emotion + pace (e.g. "calm measured encouraging")
${voicePrompt}

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "name": "string",
      "role": "teacher",
      "persona": "string (2-3 sentences)",
      "voiceDesign": { "identity": "string", "texture": "string", "delivery": "string" },
      "avatar": "string (from available list)",
      "color": "string (hex color from palette)",
      "priority": 10${voiceJsonField}
    }
  ]
}`;

    log.info(`Generating agent profiles for "${stageInfo.name}" [model=${modelString}]`);

    const rawResult = (
      await callLLM(
        {
          model: languageModel,
          system: systemPrompt,
          prompt: userPrompt,
        },
        'agent-profiles',
        undefined,
        thinkingConfig,
      )
    ).text;

    // ── Parse LLM response ──
    const rawText = stripCodeFences(rawResult);
    let parsed: {
      agents: Array<{
        name: string;
        role: string;
        persona: string;
        avatar: string;
        color: string;
        priority: number;
        voice?: string;
        voiceDesign?: unknown;
      }>;
    };

    try {
      parsed = JSON.parse(rawText);
    } catch {
      log.error('Failed to parse LLM response as JSON:', rawText.substring(0, 500));
      return apiError('PARSE_FAILED', 500, 'Failed to parse agent profiles from LLM response');
    }

    // ── Validate parsed structure ──
    if (!parsed.agents || !Array.isArray(parsed.agents) || parsed.agents.length < 1) {
      log.error(`Expected at least 1 agent, got ${parsed.agents?.length ?? 0}`);
      return apiError(
        'GENERATION_FAILED',
        500,
        `Expected at least 1 agent but LLM returned ${parsed.agents?.length ?? 0}`,
      );
    }

    const teacherCount = parsed.agents.filter((a) => a.role === 'teacher').length;
    if (teacherCount !== 1) {
      log.error(`Expected exactly 1 teacher, got ${teacherCount}`);
      return apiError(
        'GENERATION_FAILED',
        500,
        `Expected exactly 1 teacher but LLM returned ${teacherCount}`,
      );
    }

    // Drop any extra classmate / assistant the model may have emitted.
    const teacherAgents = parsed.agents.filter((a) => a.role === 'teacher');

    // ── Build output with IDs ──
    const agents = teacherAgents.map((agent, index) => {
      // Parse voice "providerId::voiceId" format
      let voiceConfig: { providerId: string; voiceId: string } | undefined;
      if (agent.voice && agent.voice.includes('::')) {
        const [providerId, voiceId] = agent.voice.split('::');
        if (providerId && voiceId) {
          voiceConfig = { providerId, voiceId };
        }
      }

      const voiceDesign = normalizeVoiceDesign(agent.voiceDesign);

      return {
        id: `gen-${nanoid(8)}`,
        name: agent.name,
        role: agent.role,
        persona: agent.persona,
        avatar: agent.avatar || availableAvatars[index % availableAvatars.length],
        color: agent.color || AGENT_COLOR_PALETTE[index % AGENT_COLOR_PALETTE.length],
        priority:
          agent.priority ?? (agent.role === 'teacher' ? 10 : agent.role === 'assistant' ? 7 : 5),
        ...(voiceConfig ? { voiceConfig } : {}),
        ...(voiceDesign ? { voiceDesign } : {}),
      };
    });

    log.info(`Successfully generated ${agents.length} agent profiles for "${stageInfo.name}"`);

    return apiSuccess({ agents });
  } catch (error) {
    log.error(
      `Agent profiles generation failed [stage="${stageName ?? 'unknown'}", model=${modelString ?? 'unknown'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
