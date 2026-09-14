'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  X,
  Trash2,
  Box,
  Settings,
  CheckCircle2,
  XCircle,
  FileText,
  Image as ImageIcon,
  Film,
  Search,
  Volume2,
  Mic,
  Plus,
  CreditCard,
  PersonStanding,
  AudioLines,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore, saveSettings } from '@/lib/store/settings';
import { useProviderCredentials } from './use-provider-credentials';
import { toast } from 'sonner';
import { type ProviderId } from '@/lib/ai/providers';
import { PROVIDERS, MONO_LOGO_PROVIDERS } from '@/lib/ai/providers';
import { modelIdsMatch } from '@/lib/ai/model-aliases';
import { cn } from '@/lib/utils';
import {
  createCustomProviderSettings,
  getProviderTypeLabel,
  isProviderInUse,
  modelInfoFromId,
} from './utils';
import { ProviderList } from './provider-list';
import { ProviderConfigPanel } from './provider-config-panel';
import { PDFSettings } from './pdf-settings';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import { ImageSettings } from './image-settings';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import type { ImageProviderId } from '@/lib/media/types';
import { VideoSettings } from './video-settings';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import type { VideoProviderId } from '@/lib/media/types';
import { TTSSettings } from './tts-settings';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import type { TTSProviderId } from '@/lib/audio/types';
import { ASRSettings } from './asr-settings';
import { ASR_PROVIDERS } from '@/lib/audio/constants';
import type { ASRProviderId } from '@/lib/audio/types';
import { WebSearchSettings } from './web-search-settings';
import { WEB_SEARCH_PROVIDERS, getWebSearchProviderDisplayName } from '@/lib/web-search/constants';
import { GeneralSettings } from './general-settings';
import { AvatarSettings } from './avatar-settings';
import { RealtimeSettings } from './realtime-settings';
import { TokenPlanSettings } from './token-plan-settings';
import { ModelEditDialog } from './model-edit-dialog';
import { AddProviderDialog, type NewProviderData } from './add-provider-dialog';
import { AddAudioProviderDialog, type NewAudioProviderData } from './add-audio-provider-dialog';
import { isCustomTTSProvider, isCustomASRProvider } from '@/lib/audio/types';
import { resolveASRProviderName, resolveTTSProviderName } from '@/lib/audio/provider-display';
import type { SettingsSection, EditingModel, RealtimeProviderId } from '@/lib/types/settings';
import { REALTIME_PROVIDERS } from '@/lib/livecourse/realtime/providers';
import { isLiveCourseTTSEnabled } from '@/lib/config/feature-flags';

// ─── Provider List Column (reusable) ───
function ProviderListColumn<T extends string>({
  providers,
  configs,
  selectedId,
  onSelect,
  width,
  t,
  onAdd,
}: {
  providers: Array<{ id: T; name: string; icon?: string }>;
  configs: Record<string, { isServerConfigured?: boolean }>;
  selectedId: T;
  onSelect: (id: T) => void;
  width: number;
  t: (key: string) => string;
  onAdd?: () => void;
}) {
  return (
    <div className="flex-shrink-0 bg-background flex flex-col" style={{ width }}>
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {providers.map((provider) => (
          <button
            key={provider.id}
            aria-pressed={selectedId === provider.id}
            onClick={() => onSelect(provider.id)}
            className={cn(
              'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg transition-all border text-left',
              selectedId === provider.id
                ? 'bg-primary/5 border-primary/50 shadow-sm'
                : 'border-transparent hover:bg-muted/50',
            )}
          >
            {provider.icon ? (
              <img
                src={provider.icon}
                alt={provider.name}
                className={cn(
                  'w-5 h-5 rounded',
                  MONO_LOGO_PROVIDERS.has(provider.id) && 'dark:invert',
                )}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Box className="h-5 w-5 text-muted-foreground" />
            )}
            <span className="font-medium text-sm flex-1 truncate">{provider.name}</span>
            {configs[provider.id]?.isServerConfigured && (
              <span className="text-[10px] px-1 py-0 h-4 leading-4 rounded shrink-0 bg-muted text-muted-foreground">
                {t('settings.serverConfigured')}
              </span>
            )}
          </button>
        ))}
      </div>
      {onAdd && (
        <div className="p-3 border-t">
          <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={onAdd}>
            <Plus className="h-3.5 w-3.5" />
            {t('settings.addProviderButton')}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Helper: get TTS/ASR provider display name ───
// The id→i18n-key tables live in lib/audio/provider-display so the generation
// toolbar resolves provider names the same way this dialog does.
function getTTSProviderName(providerId: TTSProviderId, t: (key: string) => string): string {
  if (isCustomTTSProvider(providerId)) {
    const cfg = useSettingsStore.getState().ttsProvidersConfig[providerId];
    return cfg?.customName || providerId;
  }
  return resolveTTSProviderName(providerId, t);
}

function getASRProviderName(providerId: ASRProviderId, t: (key: string) => string): string {
  if (isCustomASRProvider(providerId)) {
    const cfg = useSettingsStore.getState().asrProvidersConfig[providerId];
    return cfg?.customName || providerId;
  }
  return resolveASRProviderName(providerId, t);
}

// ─── Image/Video provider name helpers ───
const IMAGE_PROVIDER_NAMES: Record<ImageProviderId, string> = {
  seedream: 'providerSeedream',
  'openai-image': 'providerOpenAIImage',
  'qwen-image': 'providerQwenImage',
  'nano-banana': 'providerNanoBanana',
  'minimax-image': 'providerMiniMaxImage',
  'grok-image': 'providerGrokImage',
  'comfyui-image': 'providerComfyUIImage',
  lemonade: 'providerLemonadeImage',
};

const IMAGE_PROVIDER_ICONS: Record<ImageProviderId, string> = {
  seedream: '/logos/doubao.svg',
  'openai-image': '/logos/openai.svg',
  'qwen-image': '/logos/bailian.svg',
  'nano-banana': '/logos/gemini.svg',
  'minimax-image': '/logos/minimax.svg',
  'grok-image': '/logos/grok.svg',
  'comfyui-image': '/logos/comfyui.svg',
  lemonade: '/logos/lemonade.svg',
};

const VIDEO_PROVIDER_NAMES: Record<VideoProviderId, string> = {
  seedance: 'providerSeedance',
  kling: 'providerKling',
  veo: 'providerVeo',
  sora: 'providerSora',
  'minimax-video': 'providerMiniMaxVideo',
  'grok-video': 'providerGrokVideo',
  happyhorse: 'providerHappyHorse',
};

const VIDEO_PROVIDER_ICONS: Record<VideoProviderId, string> = {
  seedance: '/logos/doubao.svg',
  kling: '/logos/kling.svg',
  veo: '/logos/gemini.svg',
  sora: '/logos/openai.svg',
  'minimax-video': '/logos/minimax.svg',
  'grok-video': '/logos/grok.svg',
  happyhorse: '/logos/qwen.svg',
};

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSection?: SettingsSection;
}

export function SettingsDialog({ open, onOpenChange, initialSection }: SettingsDialogProps) {
  const { t } = useI18n();

  // Get settings from store
  const providerId = useSettingsStore((state) => state.providerId);
  const activeModelId = useSettingsStore((state) => state.modelId);
  const providersConfig = useSettingsStore((state) => state.providersConfig);
  const pdfProviderId = useSettingsStore((state) => state.pdfProviderId);
  const pdfProvidersConfig = useSettingsStore((state) => state.pdfProvidersConfig);
  const imageProviderId = useSettingsStore((state) => state.imageProviderId);
  const imageProvidersConfig = useSettingsStore((state) => state.imageProvidersConfig);
  const videoProviderId = useSettingsStore((state) => state.videoProviderId);
  const videoProvidersConfig = useSettingsStore((state) => state.videoProvidersConfig);
  const ttsProviderId = useSettingsStore((state) => state.ttsProviderId);
  const ttsProvidersConfig = useSettingsStore((state) => state.ttsProvidersConfig);
  const asrProviderId = useSettingsStore((state) => state.asrProviderId);
  const asrProvidersConfig = useSettingsStore((state) => state.asrProvidersConfig);
  const realtimeProviderId = useSettingsStore((state) => state.realtimeProviderId);
  const realtimeProvidersConfig = useSettingsStore((state) => state.realtimeProvidersConfig);
  const setRealtimeProvider = useSettingsStore((state) => state.setRealtimeProvider);

  // Store actions
  const setProviderConfig = useSettingsStore((state) => state.setProviderConfig);
  const setProvidersConfig = useSettingsStore((state) => state.setProvidersConfig);
  const setTTSProvider = useSettingsStore((state) => state.setTTSProvider);
  const setASRProvider = useSettingsStore((state) => state.setASRProvider);

  // Navigation
  const [activeSection, setActiveSection] = useState<SettingsSection>('providers');
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderId>(providerId);
  // Built-ins the user pulled out of the catalog this session. Not persisted:
  // a revealed provider earns a permanent slot once it carries credentials
  // (isProviderInUse), otherwise it quietly returns to the catalog next visit.
  const [revealedProviderIds, setRevealedProviderIds] = useState<ReadonlySet<ProviderId>>(
    () => new Set(),
  );
  const [selectedPdfProviderId, setSelectedPdfProviderId] = useState<PDFProviderId>(pdfProviderId);
  const [selectedImageProviderId, setSelectedImageProviderId] =
    useState<ImageProviderId>(imageProviderId);
  const [selectedVideoProviderId, setSelectedVideoProviderId] =
    useState<VideoProviderId>(videoProviderId);
  const [selectedRealtimeProviderId, setSelectedRealtimeProviderId] =
    useState<RealtimeProviderId>(realtimeProviderId);
  // Navigate to initialSection when dialog opens
  useEffect(() => {
    if (open && initialSection) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Sync section from prop when dialog opens
      setActiveSection(
        initialSection === 'realtime' || initialSection === 'web-search'
          ? initialSection
          : 'providers',
      );
    }
  }, [open, initialSection]);

  // Model editing state
  const [editingModel, setEditingModel] = useState<EditingModel | null>(null);
  const [showModelDialog, setShowModelDialog] = useState(false);

  // Provider deletion confirmation
  const [providerToDelete, setProviderToDelete] = useState<ProviderId | null>(null);

  // Add provider dialog
  const [showAddProviderDialog, setShowAddProviderDialog] = useState(false);
  const [showAddTTSProviderDialog, setShowAddTTSProviderDialog] = useState(false);
  const [showAddASRProviderDialog, setShowAddASRProviderDialog] = useState(false);
  const addCustomTTSProvider = useSettingsStore((state) => state.addCustomTTSProvider);
  const addCustomASRProvider = useSettingsStore((state) => state.addCustomASRProvider);

  const handleAddTTSProvider = (data: NewAudioProviderData) => {
    const id = `custom-tts-${Date.now()}` as TTSProviderId;
    addCustomTTSProvider(id, data.name, data.baseUrl, data.requiresApiKey, data.defaultModel);
  };

  const handleAddASRProvider = (data: NewAudioProviderData) => {
    const id = `custom-asr-${Date.now()}` as ASRProviderId;
    addCustomASRProvider(id, data.name, data.baseUrl, data.requiresApiKey);
  };

  const credentials = useProviderCredentials(providersConfig, (changes) =>
    saveSettings((state) => {
      const next = { ...state.providersConfig };
      for (const [key, fields] of Object.entries(changes)) {
        const id = key as ProviderId;
        if (!next[id] || next[id].isServerConfigured) {
          throw new Error('Provider credentials are no longer editable');
        }
        next[id] = { ...next[id], ...fields };
      }
      state.setProvidersConfig(next);
    }),
  );
  const realtimeCredentialConfigs = Object.fromEntries(
    (Object.keys(REALTIME_PROVIDERS) as RealtimeProviderId[]).map((id) => [
      id,
      {
        apiKey: realtimeProvidersConfig[id]?.apiKey ?? '',
        baseUrl: '',
        requiresApiKey: true,
        isServerConfigured: realtimeProvidersConfig[id]?.isServerConfigured,
      },
    ]),
  );
  const realtimeCredentials = useProviderCredentials(realtimeCredentialConfigs, (changes) =>
    saveSettings((state) => {
      for (const [key, fields] of Object.entries(changes)) {
        const id = key as RealtimeProviderId;
        if (
          !state.realtimeProvidersConfig[id] ||
          state.realtimeProvidersConfig[id].isServerConfigured
        ) {
          throw new Error('Realtime credentials are no longer editable');
        }
        state.setRealtimeProviderConfig(id, { apiKey: fields.apiKey ?? '' });
      }
    }),
  );
  const { saveStatus, isSaving: providersSaving } = credentials;
  const isSaving = providersSaving || realtimeCredentials.isSaving;
  const handleOpenChange = (next: boolean) => {
    if (!isSaving) onOpenChange(next);
  };

  // Resizable column widths
  const [sidebarWidth, setSidebarWidth] = useState(192);
  const [providerListWidth, setProviderListWidth] = useState(192);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{
    target: 'sidebar' | 'providerList';
    startX: number;
    startWidth: number;
  } | null>(null);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, target: 'sidebar' | 'providerList') => {
      e.preventDefault();
      const startWidth = target === 'sidebar' ? sidebarWidth : providerListWidth;
      resizeRef.current = { target, startX: e.clientX, startWidth };
      setIsResizing(true);
    },
    [sidebarWidth, providerListWidth],
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeRef.current) return;
      const { target, startX, startWidth } = resizeRef.current;
      const delta = e.clientX - startX;
      const newWidth = Math.max(120, Math.min(360, startWidth + delta));
      if (target === 'sidebar') {
        setSidebarWidth(newWidth);
      } else {
        setProviderListWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      resizeRef.current = null;
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing]);

  const handleSave = () => {
    if (activeSection === 'realtime') {
      void realtimeCredentials.save();
      return;
    }
    void credentials.save();
  };

  const handleProviderSelect = (pid: ProviderId) => {
    setSelectedProviderId(pid);
  };

  // Global (providerId, modelId) — shown in the header so the model teaching the
  // class stays visible no matter which provider the middle column is browsing.
  const activeModelChip =
    activeSection === 'providers'
      ? (() => {
          const config = providersConfig[providerId];
          const model = (config?.models ?? []).find((candidate) =>
            modelIdsMatch(providerId, candidate.id, activeModelId),
          );
          if (!config || !model) return undefined;
          return { providerName: config.name, providerIcon: config.icon, modelName: model.name };
        })()
      : undefined;

  const selectedProvider = providersConfig[selectedProviderId]
    ? {
        id: selectedProviderId,
        name: providersConfig[selectedProviderId].name,
        type: providersConfig[selectedProviderId].type,
        defaultBaseUrl: providersConfig[selectedProviderId].defaultBaseUrl,
        baseUrlPlaceholder: PROVIDERS[selectedProviderId]?.baseUrlPlaceholder,
        supportsModelDiscovery: PROVIDERS[selectedProviderId]?.supportsModelDiscovery,
        alternateBaseUrls: PROVIDERS[selectedProviderId]?.alternateBaseUrls,
        icon: providersConfig[selectedProviderId].icon,
        requiresApiKey: providersConfig[selectedProviderId].requiresApiKey,
        models: providersConfig[selectedProviderId].models,
      }
    : undefined;

  // Handle model editing
  const handleEditModel = (pid: ProviderId, modelIndex: number) => {
    const allModels = providersConfig[pid]?.models || [];
    setEditingModel({
      providerId: pid,
      modelIndex,
      model: { ...allModels[modelIndex] },
    });
    setShowModelDialog(true);
  };

  const handleAddModel = () => {
    setEditingModel({
      providerId: selectedProviderId,
      modelIndex: null,
      model: {
        id: '',
        name: '',
        capabilities: {
          streaming: true,
          tools: true,
          vision: false,
        },
      },
    });
    setShowModelDialog(true);
  };

  const handleDeleteModel = (pid: ProviderId, modelIndex: number) => {
    const currentModels = providersConfig[pid]?.models || [];
    const newModels = currentModels.filter((_, i) => i !== modelIndex);
    setProviderConfig(pid, { models: newModels });
  };

  // Merge probed model ids into the provider's model list. Previously
  // probe-derived entries (`source: 'probed'`) are dropped first so a re-fetch
  // (after the user changes base URL / API key) REPLACES the stale set instead
  // of accumulating dead ids. Catalog and manually-added models are preserved.
  // `modelInfoFromId(id, pid)` keeps built-in thinking capability so the
  // thinking control isn't silently hidden for fetched built-in models.
  const handleModelsFetched = (pid: ProviderId, fetchedIds: string[]): number => {
    const currentModels = providersConfig[pid]?.models || [];
    const kept = currentModels.filter((m) => m.source !== 'probed');
    const keptIds = new Set(kept.map((m) => m.id));
    const additions = fetchedIds
      .filter((id) => !keptIds.has(id))
      .map((id) => ({ ...modelInfoFromId(id, pid), source: 'probed' as const }));
    const next = [...kept, ...additions];
    // Write when the set changed at all — additions, or stale probed ids pruned.
    if (additions.length > 0 || next.length !== currentModels.length) {
      setProviderConfig(pid, { models: next });
    }
    return additions.length;
  };

  const handleAutoSaveModel = () => {
    if (!editingModel) return;
    const { providerId: pid, modelIndex, model } = editingModel;
    if (!model.id.trim()) return;
    const currentModels = providersConfig[pid]?.models || [];
    let newModels: typeof currentModels;
    let newModelIndex = modelIndex;

    if (modelIndex === null) {
      const existingIndex = currentModels.findIndex((m) => m.id === model.id);
      if (existingIndex >= 0) {
        newModels = [...currentModels];
        newModels[existingIndex] = model;
        newModelIndex = existingIndex;
      } else {
        newModels = [...currentModels, model];
        newModelIndex = newModels.length - 1;
      }
      setProviderConfig(pid, { models: newModels });
      setEditingModel({ ...editingModel, modelIndex: newModelIndex });
    } else {
      newModels = [...currentModels];
      newModels[modelIndex] = model;
      setProviderConfig(pid, { models: newModels });
    }
  };

  const handleSaveModel = () => {
    if (!editingModel) return;
    const { providerId: pid, modelIndex, model } = editingModel;
    if (!model.id.trim()) {
      toast.error(t('settings.modelIdRequired'));
      return;
    }
    const currentModels = providersConfig[pid]?.models || [];
    let newModels: typeof currentModels;
    if (modelIndex === null) {
      newModels = [...currentModels, model];
    } else {
      newModels = [...currentModels];
      newModels[modelIndex] = model;
    }
    setProviderConfig(pid, { models: newModels });
    setShowModelDialog(false);
    setEditingModel(null);
  };

  // Handle provider management
  const handleAddProvider = (providerData: NewProviderData) => {
    if (!providerData.name.trim()) {
      toast.error(t('settings.providerNameRequired'));
      return;
    }
    const newProviderId = `custom-${Date.now()}` as ProviderId;
    const updatedConfig = {
      ...providersConfig,
      [newProviderId]: createCustomProviderSettings({
        name: providerData.name,
        type: providerData.type,
        baseUrl: providerData.baseUrl,
        icon: providerData.icon,
        requiresApiKey: providerData.requiresApiKey,
        modelsUrl: providerData.modelsUrl,
      }),
    };
    setProvidersConfig(updatedConfig);
    setShowAddProviderDialog(false);
    setSelectedProviderId(newProviderId);
  };

  const handleDeleteProvider = (pid: ProviderId) => {
    if (providersConfig[pid]?.isBuiltIn) {
      toast.error(t('settings.cannotDeleteBuiltIn'));
      return;
    }
    setProviderToDelete(pid);
  };

  const confirmDeleteProvider = () => {
    if (!providerToDelete) return;
    const pid = providerToDelete;
    const updatedConfig = { ...providersConfig };
    delete updatedConfig[pid];
    // setProvidersConfig re-resolves the global (providerId, modelId)
    // selection at the source (#580 invariant) — keep a still-usable
    // provider, fall back to another usable one, or go to State A. No
    // hand-rolled "pick the first config key" here: that ignored usability
    // and could re-select an invalid/unusable provider.
    setProvidersConfig(updatedConfig);
    if (selectedProviderId === pid) {
      // Settings-panel tab only (local UI), independent of model selection.
      const firstRemainingPid = Object.keys(updatedConfig)[0] as ProviderId | undefined;
      setSelectedProviderId(firstRemainingPid || 'openai');
    }
    credentials.discard(pid);
    setProviderToDelete(null);
  };

  const handleResetProvider = (pid: ProviderId) => {
    const provider = PROVIDERS[pid];
    if (!provider) return;
    setProviderConfig(pid, { models: [...provider.models] });
    toast.success(t('settings.resetSuccess'));
  };

  // Get all providers from providersConfig
  const allProviders = Object.entries(providersConfig).map(([id, config]) => ({
    id: id as ProviderId,
    name: config.name,
    type: config.type,
    defaultBaseUrl: config.defaultBaseUrl,
    icon: config.icon,
    requiresApiKey: config.requiresApiKey,
    models: config.models,
    isServerConfigured: config.isServerConfigured,
  }));

  // The middle column lists only providers in use (docs/spec/02「设置」: no
  // model-ecosystem shelf). Hidden built-ins stay reachable via the catalog in
  // the add-provider dialog; the active/selected provider is always visible.
  const visibleProviders = allProviders.filter(
    (provider) =>
      provider.id === providerId ||
      provider.id === selectedProviderId ||
      revealedProviderIds.has(provider.id) ||
      isProviderInUse(providersConfig[provider.id]),
  );
  const visibleProviderIds = visibleProviders.map((provider) => provider.id);
  const hiddenBuiltinProviders = allProviders.filter(
    (provider) =>
      providersConfig[provider.id]?.isBuiltIn &&
      !visibleProviders.some((visible) => visible.id === provider.id),
  );

  const getProviderDisplayName = (provider: { id: ProviderId; name: string }) => {
    const key = `settings.providerNames.${provider.id}`;
    const translated = t(key);
    return translated !== key ? translated : provider.name;
  };

  const handleRevealProvider = (pid: ProviderId) => {
    setRevealedProviderIds((previous) => new Set(previous).add(pid));
    setSelectedProviderId(pid);
    setShowAddProviderDialog(false);
  };

  // Sections that show a provider list column
  const _hasProviderList = [
    'providers',
    'pdf',
    'web-search',
    'image',
    'video',
    'tts',
    'asr',
  ].includes(activeSection);

  // Get header content based on section
  const getHeaderContent = () => {
    switch (activeSection) {
      case 'general':
        return <h2 className="text-lg font-semibold">{t('settings.systemSettings')}</h2>;
      case 'avatar':
        return <h2 className="text-lg font-semibold">{t('settings.avatar.nav')}</h2>;
      case 'realtime': {
        const realtimeProvider = REALTIME_PROVIDERS[selectedRealtimeProviderId];
        return (
          <>
            {realtimeProvider.icon ? (
              <img
                src={realtimeProvider.icon}
                alt=""
                className="h-8 w-8 rounded"
                onError={(event) => {
                  (event.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <AudioLines className="h-6 w-6 text-muted-foreground" />
            )}
            <h2 className="text-lg font-semibold">
              {t(`settings.realtime.${selectedRealtimeProviderId}`)}
            </h2>
          </>
        );
      }
      case 'token-plan':
        return <h2 className="text-lg font-semibold">{t('settings.tokenPlan.nav')}</h2>;
      case 'providers':
        if (selectedProvider) {
          return (
            <>
              {selectedProvider.icon ? (
                <img
                  src={selectedProvider.icon}
                  alt={selectedProvider.name}
                  className={cn(
                    'w-8 h-8 rounded',
                    MONO_LOGO_PROVIDERS.has(selectedProvider.id) && 'dark:invert',
                  )}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              ) : (
                <Box className="h-8 w-8 text-muted-foreground" />
              )}
              <div>
                <h2 className="text-lg font-semibold">
                  {t(`settings.providerNames.${selectedProvider.id}`) !==
                  `settings.providerNames.${selectedProvider.id}`
                    ? t(`settings.providerNames.${selectedProvider.id}`)
                    : selectedProvider.name}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {getProviderTypeLabel(selectedProvider.type, t)}
                </p>
              </div>
            </>
          );
        }
        return null;
      case 'pdf': {
        const pdfProvider = PDF_PROVIDERS[selectedPdfProviderId];
        if (!pdfProvider) return null;
        return (
          <>
            {pdfProvider.icon ? (
              <img
                src={pdfProvider.icon}
                alt={pdfProvider.name}
                className="w-8 h-8 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Box className="h-8 w-8 text-muted-foreground" />
            )}
            <h2 className="text-lg font-semibold">{pdfProvider.name}</h2>
          </>
        );
      }
      case 'web-search': {
        const wsProvider = WEB_SEARCH_PROVIDERS.zhihu;
        if (!wsProvider) return null;
        return (
          <>
            {wsProvider.icon ? (
              <img
                src={wsProvider.icon}
                alt={wsProvider.name}
                className="w-8 h-8 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Box className="h-8 w-8 text-muted-foreground" />
            )}
            <h2 className="text-lg font-semibold">
              {getWebSearchProviderDisplayName(wsProvider.id, t)}
            </h2>
          </>
        );
      }
      case 'image': {
        const imgProvider = IMAGE_PROVIDERS[selectedImageProviderId];
        const imgIcon = IMAGE_PROVIDER_ICONS[selectedImageProviderId];
        return (
          <>
            {imgIcon ? (
              <img
                src={imgIcon}
                alt={imgProvider?.name}
                className="w-8 h-8 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Box className="h-8 w-8 text-muted-foreground" />
            )}
            <h2 className="text-lg font-semibold">
              {t(`settings.${IMAGE_PROVIDER_NAMES[selectedImageProviderId]}`) || imgProvider?.name}
            </h2>
          </>
        );
      }
      case 'video': {
        const vidProvider = VIDEO_PROVIDERS[selectedVideoProviderId];
        const vidIcon = VIDEO_PROVIDER_ICONS[selectedVideoProviderId];
        return (
          <>
            {vidIcon ? (
              <img
                src={vidIcon}
                alt={vidProvider?.name}
                className="w-8 h-8 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Box className="h-8 w-8 text-muted-foreground" />
            )}
            <h2 className="text-lg font-semibold">
              {t(`settings.${VIDEO_PROVIDER_NAMES[selectedVideoProviderId]}`) || vidProvider?.name}
            </h2>
          </>
        );
      }
      case 'tts': {
        const ttsIcon = TTS_PROVIDERS[ttsProviderId as keyof typeof TTS_PROVIDERS]?.icon;
        return (
          <>
            {ttsIcon ? (
              <img
                src={ttsIcon}
                alt=""
                className="w-8 h-8 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Volume2 className="h-6 w-6 text-muted-foreground" />
            )}
            <h2 className="text-lg font-semibold">{getTTSProviderName(ttsProviderId, t)}</h2>
          </>
        );
      }
      case 'asr': {
        const asrIcon = ASR_PROVIDERS[asrProviderId as keyof typeof ASR_PROVIDERS]?.icon;
        return (
          <>
            {asrIcon ? (
              <img
                src={asrIcon}
                alt=""
                className="w-8 h-8 rounded"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <Mic className="h-6 w-6 text-muted-foreground" />
            )}
            <h2 className="text-lg font-semibold">{getASRProviderName(asrProviderId, t)}</h2>
          </>
        );
      }
      default:
        return null;
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="lc-settings-dialog h-[min(760px,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-[980px] overflow-hidden rounded-3xl p-0 gap-0 block"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{t('settings.title')}</DialogTitle>
        <DialogDescription className="sr-only">{t('settings.description')}</DialogDescription>
        <div className="flex h-full overflow-hidden">
          {/* Left Sidebar - Navigation */}
          <div className="flex-shrink-0 bg-muted/30 p-3 space-y-1" style={{ width: sidebarWidth }}>
            <div className="px-3 pb-2 pt-1">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
                {t('settings.classroomTitle')}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t('settings.classroomDescription')}
              </p>
            </div>

            <button
              aria-pressed={activeSection === 'providers'}
              onClick={() => setActiveSection('providers')}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors text-left min-w-0',
                activeSection === 'providers'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted',
              )}
            >
              <Box className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('settings.providers')}</span>
            </button>

            <button
              aria-pressed={activeSection === 'realtime'}
              onClick={() => setActiveSection('realtime')}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors text-left min-w-0',
                activeSection === 'realtime'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted',
              )}
            >
              <AudioLines className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('settings.realtime.nav')}</span>
            </button>

            <button
              aria-pressed={activeSection === 'web-search'}
              onClick={() => setActiveSection('web-search')}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2 text-sm rounded-lg transition-colors text-left min-w-0',
                activeSection === 'web-search'
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted',
              )}
            >
              <Search className="h-4 w-4 shrink-0" />
              <span className="truncate">{t('settings.webSearchSettings')}</span>
            </button>
          </div>

          {/* Sidebar resize handle */}
          <div
            onMouseDown={(e) => handleResizeStart(e, 'sidebar')}
            className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
          >
            <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
          </div>

          {/* Middle - Provider List (only shown for provider-based sections) */}
          {activeSection === 'providers' && (
            <>
              <ProviderList
                providers={visibleProviders}
                selectedProviderId={selectedProviderId}
                onSelect={handleProviderSelect}
                onAddProvider={() => setShowAddProviderDialog(true)}
                width={providerListWidth}
              />
              <div
                onMouseDown={(e) => handleResizeStart(e, 'providerList')}
                className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
              >
                <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            </>
          )}

          {activeSection === 'pdf' && (
            <>
              <ProviderListColumn
                providers={Object.values(PDF_PROVIDERS)}
                configs={pdfProvidersConfig}
                selectedId={selectedPdfProviderId}
                onSelect={setSelectedPdfProviderId}
                width={providerListWidth}
                t={t}
              />
              <div
                onMouseDown={(e) => handleResizeStart(e, 'providerList')}
                className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
              >
                <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            </>
          )}

          {/* web-search has a single provider (Zhihu) — no middle provider column */}

          {activeSection === 'image' && (
            <>
              <ProviderListColumn
                providers={Object.values(IMAGE_PROVIDERS).map((p) => ({
                  id: p.id,
                  name: t(`settings.${IMAGE_PROVIDER_NAMES[p.id]}`) || p.name,
                  icon: IMAGE_PROVIDER_ICONS[p.id],
                }))}
                configs={imageProvidersConfig}
                selectedId={selectedImageProviderId}
                onSelect={setSelectedImageProviderId}
                width={providerListWidth}
                t={t}
              />
              <div
                onMouseDown={(e) => handleResizeStart(e, 'providerList')}
                className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
              >
                <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            </>
          )}

          {activeSection === 'video' && (
            <>
              <ProviderListColumn
                providers={Object.values(VIDEO_PROVIDERS).map((p) => ({
                  id: p.id,
                  name: t(`settings.${VIDEO_PROVIDER_NAMES[p.id]}`) || p.name,
                  icon: VIDEO_PROVIDER_ICONS[p.id],
                }))}
                configs={videoProvidersConfig}
                selectedId={selectedVideoProviderId}
                onSelect={setSelectedVideoProviderId}
                width={providerListWidth}
                t={t}
              />
              <div
                onMouseDown={(e) => handleResizeStart(e, 'providerList')}
                className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
              >
                <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            </>
          )}

          {isLiveCourseTTSEnabled() && activeSection === 'tts' && (
            <>
              <ProviderListColumn
                providers={[
                  ...Object.values(TTS_PROVIDERS).map((p) => ({
                    id: p.id,
                    name: getTTSProviderName(p.id, t),
                    icon: p.icon,
                  })),
                  ...Object.entries(ttsProvidersConfig)
                    .filter(([id]) => isCustomTTSProvider(id))
                    .map(([id, cfg]) => ({
                      id: id as TTSProviderId,
                      name: cfg.customName || id,
                      icon: undefined,
                    })),
                ]}
                configs={ttsProvidersConfig}
                selectedId={ttsProviderId}
                onSelect={setTTSProvider}
                width={providerListWidth}
                t={t}
                onAdd={() => setShowAddTTSProviderDialog(true)}
              />
              <div
                onMouseDown={(e) => handleResizeStart(e, 'providerList')}
                className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
              >
                <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            </>
          )}

          {activeSection === 'asr' && (
            <>
              <ProviderListColumn
                providers={[
                  ...Object.values(ASR_PROVIDERS).map((p) => ({
                    id: p.id,
                    name: getASRProviderName(p.id, t),
                    icon: p.icon,
                  })),
                  ...Object.entries(asrProvidersConfig)
                    .filter(([id]) => isCustomASRProvider(id))
                    .map(([id, cfg]) => ({
                      id: id as ASRProviderId,
                      name: cfg.customName || id,
                      icon: undefined,
                    })),
                ]}
                configs={asrProvidersConfig}
                selectedId={asrProviderId}
                onSelect={setASRProvider}
                width={providerListWidth}
                t={t}
                onAdd={() => setShowAddASRProviderDialog(true)}
              />
              <div
                onMouseDown={(e) => handleResizeStart(e, 'providerList')}
                className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
              >
                <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            </>
          )}

          {activeSection === 'realtime' && (
            <>
              <ProviderListColumn
                providers={(Object.keys(REALTIME_PROVIDERS) as RealtimeProviderId[]).map((id) => ({
                  id,
                  name: t(`settings.realtime.${id}`),
                  icon: REALTIME_PROVIDERS[id].icon,
                }))}
                configs={realtimeProvidersConfig}
                selectedId={selectedRealtimeProviderId}
                onSelect={(id) => {
                  setSelectedRealtimeProviderId(id);
                  setRealtimeProvider(id);
                }}
                width={providerListWidth}
                t={t}
              />
              <div
                onMouseDown={(e) => handleResizeStart(e, 'providerList')}
                className="flex-shrink-0 w-[5px] cursor-col-resize group flex justify-center"
              >
                <div className="w-px h-full bg-border group-hover:bg-primary/50 transition-colors" />
              </div>
            </>
          )}

          {/* Right - Configuration Panel */}
          <div className="min-h-0 flex-1 flex flex-col overflow-hidden min-w-0">
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between gap-3 p-5 border-b">
              <div className="flex min-w-0 items-center gap-3 [&>h2]:truncate [&>img]:shrink-0">
                {getHeaderContent()}
                {activeModelChip && (
                  <>
                    <div className="h-6 w-px shrink-0 bg-border" />
                    <button
                      type="button"
                      onClick={() => handleProviderSelect(providerId)}
                      title={t('settings.currentlyUsing')}
                      className="flex min-w-0 items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary transition-colors hover:bg-primary/20"
                    >
                      {activeModelChip.providerIcon ? (
                        <img
                          src={activeModelChip.providerIcon}
                          alt=""
                          className={cn(
                            'h-3.5 w-3.5 shrink-0 rounded',
                            MONO_LOGO_PROVIDERS.has(providerId) && 'dark:invert',
                          )}
                          onError={(event) => {
                            (event.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      )}
                      {providerId !== selectedProviderId && (
                        <span className="shrink-0 opacity-70">{activeModelChip.providerName} /</span>
                      )}
                      <span className="max-w-48 truncate font-mono">
                        {activeModelChip.modelName}
                      </span>
                    </button>
                  </>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {activeSection === 'providers' &&
                  !providersConfig[selectedProviderId]?.isBuiltIn && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-destructive hover:text-destructive"
                      aria-label={t('settings.deleteProvider')}
                      onClick={() => handleDeleteProvider(selectedProviderId)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                <Button
                  aria-label={t('settings.close')}
                  variant="ghost"
                  size="icon"
                  onClick={() => handleOpenChange(false)}
                  disabled={isSaving}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Content */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
              {credentials.blockedProviders.map((id) => (
                <div
                  key={id}
                  role="alert"
                  className="mb-4 rounded-lg border border-destructive/30 p-3 text-sm"
                >
                  <p>
                    {t('settings.unavailableCredentialDraft', {
                      name: providersConfig[id as ProviderId]?.name ?? id,
                    })}
                  </p>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="mt-2 h-auto p-0"
                    disabled={isSaving}
                    onClick={() => credentials.discard(id)}
                  >
                    {t('settings.discardDraft')}
                  </Button>
                </div>
              ))}
              {activeSection === 'general' && <GeneralSettings />}

              {activeSection === 'avatar' && <AvatarSettings />}

              {activeSection === 'token-plan' && <TokenPlanSettings />}

              {activeSection === 'providers' && selectedProvider && (
                <ProviderConfigPanel
                  provider={selectedProvider}
                  credentials={credentials.values(selectedProviderId)}
                  saving={isSaving}
                  fieldStatus={(field) => credentials.status(selectedProviderId, field)}
                  dirty={(field) => credentials.dirty(selectedProviderId, field)}
                  providersConfig={providersConfig}
                  onConfigChange={(field, value) =>
                    credentials.change(selectedProviderId, field, value)
                  }
                  onSave={(field) => {
                    void credentials.save(selectedProviderId, field);
                  }}
                  onEditModel={(index) => handleEditModel(selectedProviderId, index)}
                  onDeleteModel={(index) => handleDeleteModel(selectedProviderId, index)}
                  onAddModel={handleAddModel}
                  onModelsFetched={(ids) => handleModelsFetched(selectedProviderId, ids)}
                  modelsUrl={providersConfig[selectedProviderId]?.modelsUrl}
                  onResetToDefault={() => handleResetProvider(selectedProviderId)}
                  isBuiltIn={providersConfig[selectedProviderId]?.isBuiltIn ?? true}
                  onNavigateProvider={handleProviderSelect}
                  visibleProviderIds={visibleProviderIds}
                />
              )}

              {activeSection === 'pdf' && (
                <PDFSettings selectedProviderId={selectedPdfProviderId} />
              )}
              {activeSection === 'web-search' && <WebSearchSettings />}
              {activeSection === 'image' && (
                <ImageSettings selectedProviderId={selectedImageProviderId} />
              )}
              {activeSection === 'video' && (
                <VideoSettings selectedProviderId={selectedVideoProviderId} />
              )}
              {isLiveCourseTTSEnabled() && activeSection === 'tts' && (
                <TTSSettings selectedProviderId={ttsProviderId} />
              )}
              {activeSection === 'asr' && <ASRSettings selectedProviderId={asrProviderId} />}
              {activeSection === 'realtime' && (
                <RealtimeSettings
                  selectedProviderId={selectedRealtimeProviderId}
                  credentials={realtimeCredentials.values(selectedRealtimeProviderId)}
                  saving={realtimeCredentials.isSaving}
                  isServerConfigured={
                    !!realtimeProvidersConfig[selectedRealtimeProviderId]?.isServerConfigured
                  }
                  fieldStatus={(field) =>
                    realtimeCredentials.status(selectedRealtimeProviderId, field)
                  }
                  dirty={(field) => realtimeCredentials.dirty(selectedRealtimeProviderId, field)}
                  onConfigChange={(field, value) =>
                    realtimeCredentials.change(selectedRealtimeProviderId, field, value)
                  }
                  onSave={(field) => {
                    void realtimeCredentials.save(selectedRealtimeProviderId, field);
                  }}
                />
              )}
            </div>

            {/* Footer */}
            <div className="flex shrink-0 items-center justify-end gap-3 px-5 py-3 border-t bg-muted/30">
              {activeSection === 'providers' && saveStatus === 'saving' && (
                <span role="status" className="text-sm text-muted-foreground">
                  {t('settings.saving')}
                </span>
              )}
              {activeSection === 'providers' && saveStatus === 'saved' && (
                <div
                  role="status"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  <span>{t('settings.saveSuccess')}</span>
                </div>
              )}
              {activeSection === 'providers' && saveStatus === 'error' && (
                <div role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
                  <XCircle className="h-4 w-4" />
                  <span>{t('settings.saveFailed')}</span>
                </div>
              )}
              {activeSection === 'realtime' && realtimeCredentials.saveStatus === 'saving' && (
                <span role="status" className="text-sm text-muted-foreground">
                  {t('settings.saving')}
                </span>
              )}
              {activeSection === 'realtime' && realtimeCredentials.saveStatus === 'saved' && (
                <div
                  role="status"
                  className="flex items-center gap-1.5 text-sm text-muted-foreground"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  <span>{t('settings.saveSuccess')}</span>
                </div>
              )}
              {activeSection === 'realtime' && realtimeCredentials.saveStatus === 'error' && (
                <div role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
                  <XCircle className="h-4 w-4" />
                  <span>{t('settings.saveFailed')}</span>
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleOpenChange(false)}
                disabled={isSaving}
              >
                {t('settings.close')}
              </Button>
              {(activeSection === 'providers' ||
                (activeSection === 'realtime' &&
                  !realtimeProvidersConfig[selectedRealtimeProviderId]?.isServerConfigured)) && (
                <Button size="sm" onClick={handleSave} disabled={isSaving}>
                  {t('settings.save')}
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>

      {/* Edit Model Dialog */}
      <ModelEditDialog
        open={showModelDialog}
        onOpenChange={setShowModelDialog}
        editingModel={editingModel}
        setEditingModel={setEditingModel}
        onSave={handleSaveModel}
        onAutoSave={handleAutoSaveModel}
        providerId={selectedProviderId}
        apiKey={providersConfig[selectedProviderId]?.apiKey || ''}
        baseUrl={providersConfig[selectedProviderId]?.baseUrl}
        providerType={providersConfig[selectedProviderId]?.type}
        requiresApiKey={providersConfig[selectedProviderId]?.requiresApiKey}
        isServerConfigured={providersConfig[selectedProviderId]?.isServerConfigured}
      />

      {/* Add Provider Dialog */}
      <AddProviderDialog
        open={showAddProviderDialog}
        onOpenChange={setShowAddProviderDialog}
        onAdd={handleAddProvider}
        catalogProviders={hiddenBuiltinProviders.map((provider) => ({
          id: provider.id,
          name: getProviderDisplayName(provider),
          icon: provider.icon,
        }))}
        onSelectBuiltin={handleRevealProvider}
      />

      {/* Add TTS Provider Dialog */}
      <AddAudioProviderDialog
        open={showAddTTSProviderDialog}
        onOpenChange={setShowAddTTSProviderDialog}
        onAdd={handleAddTTSProvider}
        type="tts"
      />

      {/* Add ASR Provider Dialog */}
      <AddAudioProviderDialog
        open={showAddASRProviderDialog}
        onOpenChange={setShowAddASRProviderDialog}
        onAdd={handleAddASRProvider}
        type="asr"
      />

      {/* Delete Provider Confirmation */}
      <AlertDialog
        open={providerToDelete !== null}
        onOpenChange={(open) => !open && setProviderToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.deleteProvider')}</AlertDialogTitle>
            <AlertDialogDescription>{t('settings.deleteProviderConfirm')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('settings.cancelEdit')}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteProvider}>
              {t('settings.deleteProvider')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
