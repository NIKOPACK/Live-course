'use client';

import { useRef, useState } from 'react';

export interface ProviderCredentials {
  apiKey: string;
  baseUrl: string;
  requiresApiKey: boolean;
}
export type CredentialField = keyof ProviderCredentials;
export type FieldSaveStatus = 'idle' | 'saving' | 'saved' | 'error';
export type CredentialChanges = Record<string, Partial<ProviderCredentials>>;
type FieldStatuses = Record<
  string,
  Partial<Record<CredentialField, { status: FieldSaveStatus; value: string | boolean }>>
>;
export type CredentialConfigs = Record<
  string,
  (ProviderCredentials & { isServerConfigured?: boolean }) | undefined
>;

// Drafts are UI state, independent of store rehydration and learning memory.
// Only explicit submission crosses the injected configuration persistence seam.
export function useProviderCredentials(
  configs: CredentialConfigs,
  persist: (changes: CredentialChanges) => Promise<void>,
) {
  const [drafts, setDrafts] = useState<CredentialChanges>({});
  const draftsRef = useRef(drafts);
  const [statuses, setStatuses] = useState<FieldStatuses>({});
  const [saveStatus, setSaveStatus] = useState<FieldSaveStatus>('idle');
  const savingRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);

  function change<K extends CredentialField>(
    providerId: string,
    field: K,
    value: ProviderCredentials[K],
  ) {
    const next = {
      ...draftsRef.current,
      [providerId]: { ...draftsRef.current[providerId], [field]: value },
    };
    draftsRef.current = next;
    setDrafts(next);
    setStatuses((previous) => ({
      ...previous,
      [providerId]: { ...previous[providerId], [field]: { status: 'idle', value } },
    }));
    setSaveStatus('idle');
  }

  async function save(providerId?: string, field?: CredentialField) {
    if (savingRef.current) return;
    const changes: CredentialChanges = {};
    for (const [id, values] of Object.entries(draftsRef.current)) {
      if (!configs[id] || configs[id].isServerConfigured) continue;
      if (providerId && id !== providerId) continue;
      const selected = Object.fromEntries(
        Object.entries(values).filter(([key]) => !field || key === field),
      );
      if (Object.keys(selected).length) changes[id] = selected;
    }
    const mark = (status: FieldSaveStatus) => {
      const currentDrafts = draftsRef.current;
      setStatuses((previous) => {
        const next = { ...previous };
        for (const [id, values] of Object.entries(changes)) {
          next[id] = { ...next[id] };
          for (const key of Object.keys(values) as CredentialField[]) {
            // A response for an older draft must not label newer input as saved.
            const value = values[key];
            if (value !== undefined && currentDrafts[id]?.[key] === value)
              next[id][key] = { status, value };
          }
        }
        return next;
      });
    };
    if (!Object.keys(changes).length && Object.keys(draftsRef.current).length) {
      setSaveStatus('error');
      return;
    }
    savingRef.current = true;
    setIsSaving(true);
    setSaveStatus('saving');
    mark('saving');
    try {
      await persist(changes);
      mark('saved');
      const next = { ...draftsRef.current };
      for (const [id, values] of Object.entries(changes)) {
        next[id] = { ...next[id] };
        for (const key of Object.keys(values) as CredentialField[]) {
          if (next[id][key] === values[key]) delete next[id][key];
        }
        if (!Object.keys(next[id]).length) delete next[id];
      }
      draftsRef.current = next;
      setDrafts(next);
      setSaveStatus(Object.keys(next).length ? 'idle' : 'saved');
    } catch {
      // The storage seam reports the underlying error; never include secrets
      // in UI messages. Failed drafts remain available for field-local retry.
      mark('error');
      setSaveStatus('error');
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }

  function discard(providerId: string) {
    const next = { ...draftsRef.current };
    delete next[providerId];
    draftsRef.current = next;
    setDrafts(next);
    setStatuses((previous) => {
      const result = { ...previous };
      delete result[providerId];
      return result;
    });
    setSaveStatus('idle');
  }

  const values = (id: string): ProviderCredentials => ({
    apiKey: configs[id]?.apiKey ?? '',
    baseUrl: configs[id]?.baseUrl ?? '',
    requiresApiKey: configs[id]?.requiresApiKey ?? true,
    ...drafts[id],
  });
  const status = (id: string, field: CredentialField): FieldSaveStatus => {
    const feedback = statuses[id]?.[field];
    if (!feedback || feedback.value !== values(id)[field]) return 'idle';
    return feedback.status;
  };
  const staleReceipt = Object.entries(statuses).some(([id, fields]) =>
    (Object.keys(fields) as CredentialField[]).some(
      (field) => fields[field]?.status === 'saved' && status(id, field) !== 'saved',
    ),
  );

  return {
    change,
    save,
    discard,
    saveStatus: saveStatus === 'saved' && staleReceipt ? 'idle' : saveStatus,
    isSaving,
    values,
    status,
    blockedProviders: Object.keys(drafts).filter(
      (id) => !configs[id] || configs[id].isServerConfigured,
    ),
    dirty: (id: string, field: CredentialField) => Object.hasOwn(drafts[id] ?? {}, field),
  };
}
