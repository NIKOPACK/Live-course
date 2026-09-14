'use client';

import { ExternalLink } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { AiriTrackingMode } from '@/lib/livecourse/avatar/vendor/airi/eye-tracking';
import { AVATAR_TRACKING_MODES, useAvatarSettingsStore } from '@/lib/store/avatar-settings';

export function AvatarSettings() {
  const { t } = useI18n();
  const enabled = useAvatarSettingsStore((s) => s.enabled);
  const modelUrl = useAvatarSettingsStore((s) => s.modelUrl);
  const idleAnimationUrl = useAvatarSettingsStore((s) => s.idleAnimationUrl);
  const trackingMode = useAvatarSettingsStore((s) => s.trackingMode);
  const interactionsEnabled = useAvatarSettingsStore((s) => s.interactionsEnabled);
  const setEnabled = useAvatarSettingsStore((s) => s.setEnabled);
  const setModelUrl = useAvatarSettingsStore((s) => s.setModelUrl);
  const setIdleAnimationUrl = useAvatarSettingsStore((s) => s.setIdleAnimationUrl);
  const setTrackingMode = useAvatarSettingsStore((s) => s.setTrackingMode);
  const setInteractionsEnabled = useAvatarSettingsStore((s) => s.setInteractionsEnabled);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="avatar-enabled">{t('settings.avatar.enabled')}</Label>
          <p className="text-sm text-muted-foreground">{t('settings.avatar.enabledDesc')}</p>
        </div>
        <Switch id="avatar-enabled" checked={enabled} onCheckedChange={setEnabled} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="avatar-model-url">{t('settings.avatar.modelUrl')}</Label>
        <Input
          id="avatar-model-url"
          value={modelUrl}
          onChange={(event) => setModelUrl(event.target.value)}
          placeholder={t('settings.avatar.modelUrlPlaceholder')}
          disabled={!enabled}
        />
        <p className="text-sm text-muted-foreground">{t('settings.avatar.modelUrlDesc')}</p>
        <a
          href="https://hub.vroid.com/en"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          {t('settings.avatar.findModels')}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      <div className="space-y-2">
        <Label htmlFor="avatar-idle-url">{t('settings.avatar.idleAnimationUrl')}</Label>
        <Input
          id="avatar-idle-url"
          value={idleAnimationUrl}
          onChange={(event) => setIdleAnimationUrl(event.target.value)}
          placeholder={t('settings.avatar.idleAnimationUrlPlaceholder')}
          disabled={!enabled}
        />
        <p className="text-sm text-muted-foreground">{t('settings.avatar.idleAnimationUrlDesc')}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="avatar-tracking-mode">{t('settings.avatar.trackingMode')}</Label>
        <Select
          value={trackingMode}
          onValueChange={(value) => setTrackingMode(value as AiriTrackingMode)}
          disabled={!enabled}
        >
          <SelectTrigger id="avatar-tracking-mode" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AVATAR_TRACKING_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {t(`settings.avatar.trackingModes.${mode}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">{t('settings.avatar.trackingModeDesc')}</p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="avatar-interactions">{t('settings.avatar.interactions')}</Label>
          <p className="text-sm text-muted-foreground">{t('settings.avatar.interactionsDesc')}</p>
        </div>
        <Switch
          id="avatar-interactions"
          checked={interactionsEnabled}
          onCheckedChange={setInteractionsEnabled}
          disabled={!enabled}
        />
      </div>
    </div>
  );
}
