import type { ProviderId, ProviderType, ModelInfo } from '@/lib/types/provider';
import type { ProviderSettings } from '@/lib/types/settings';
import { getCatalogThinkingCapability } from '@/lib/ai/model-metadata';

/**
 * Whether a provider earns a permanent slot in the settings provider list:
 * operator-managed, custom (user-created), or carrying user-entered
 * credentials. Everything else is catalog noise — the built-in registry
 * materializes ~20 entries into providersConfig, and listing all of them is
 * the "model ecosystem" the product manual forbids (docs/spec/02「设置」).
 * Keyless providers count only with an explicit user baseUrl — the registry
 * default URL alone is not user intent (mirrors isLLMProviderConfigured).
 */
export function isProviderInUse(config: ProviderSettings | undefined): boolean {
  if (!config) return false;
  if (config.isServerConfigured) return true;
  if (!config.isBuiltIn) return true;
  if (config.apiKey?.trim()) return true;
  if (config.requiresApiKey === false && config.baseUrl?.trim()) return true;
  return false;
}

/** Heuristic: model ids matching this are treated as vision-capable. */
const VISION_MODEL_PATTERN = /vision|vl|omni|4o|gpt-5|gemini|claude/i;

/**
 * Builds a default ModelInfo from a probed model id. Vision capability is
 * inferred from the id via {@link VISION_MODEL_PATTERN}. Shared by the provider
 * panel and the token-plan apply flow so the heuristic stays in one place.
 *
 * When `providerId` is given, the built-in thinking capability for that
 * (provider, model) pair is overlaid — so a model that supports configurable
 * thinking keeps its `capabilities.thinking` instead of silently losing it
 * (which would hide InlineThinkingControl). Unknown pairs are unaffected.
 */
export function modelInfoFromId(id: string, providerId?: string): ModelInfo {
  const thinking = providerId ? getCatalogThinkingCapability(providerId, id) : undefined;
  return {
    id,
    name: id,
    capabilities: {
      streaming: true,
      tools: true,
      vision: VISION_MODEL_PATTERN.test(id),
      ...(thinking ? { thinking } : {}),
    },
  };
}

interface NewCustomProviderConfig {
  name: string;
  type: ProviderType;
  baseUrl: string;
  icon: string;
  requiresApiKey: boolean;
  /** Optional explicit /models URL override (from a preset). */
  modelsUrl?: string;
}

export function formatContextWindow(size?: number): string {
  if (!size) return '-';

  // For M: prefer decimal (use decimal for exact thousands)
  if (size >= 1000000) {
    if (size % 1000000 === 0) {
      return `${size / 1000000}M`;
    }
    return `${(size / 1000000).toFixed(1)}M`;
  }

  // For K: prefer decimal if divisible by 1000, otherwise use binary
  if (size >= 1000) {
    if (size % 1000 === 0) {
      return `${size / 1000}K`;
    }
    return `${Math.floor(size / 1024)}K`;
  }

  return size.toString();
}

export function getProviderTypeLabel(type: string, t: (key: string) => string): string {
  const translationKey = `settings.providerTypes.${type}`;
  const translated = t(translationKey);
  // If translation exists (not equal to key), use it; otherwise fallback to type
  return translated !== translationKey ? translated : type;
}

export function createCustomProviderSettings(
  providerData: NewCustomProviderConfig,
): ProviderSettings {
  return {
    apiKey: '',
    baseUrl: providerData.baseUrl || '',
    models: [],
    name: providerData.name,
    type: providerData.type,
    defaultBaseUrl: providerData.baseUrl || undefined,
    icon: providerData.icon || undefined,
    requiresApiKey: providerData.requiresApiKey,
    isBuiltIn: false,
    modelsUrl: providerData.modelsUrl || undefined,
  };
}

interface VerifyModelRequestConfig {
  providerId: ProviderId;
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  providerType?: ProviderType | string;
  requiresApiKey?: boolean;
}

export function createVerifyModelRequest(config: VerifyModelRequestConfig) {
  return {
    apiKey: config.apiKey || '',
    baseUrl: config.baseUrl || '',
    model: `${config.providerId}:${config.modelId}`,
    providerType: config.providerType,
    requiresApiKey: config.requiresApiKey,
  };
}
