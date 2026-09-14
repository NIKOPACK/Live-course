'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { nanoid } from 'nanoid';
import { dedupeCourseMaterialFiles } from '@/lib/document/course-materials';
import { normalizeDocumentMimeType } from '@/lib/document/mime';
import type { CourseMaterialUpload, SessionDocumentSource } from '@/lib/types/generation';

interface MaterialStorage {
  storeDocumentBlob: (file: File) => Promise<string>;
  deleteDocumentBlob: (key: string) => Promise<void>;
  onCleanupError: (error: unknown) => void;
}

const EMPTY_MATERIALS: CourseMaterialUpload[] = [];

// One immutable snapshot owns both rendering and same-event commands. Keeping
// a second copy in React state/ref would let batched selections or removals race.
function createMaterialUploads(storage: MaterialStorage) {
  let items = EMPTY_MATERIALS;
  let active = false;
  let disposed = false;
  let handedOff = false;
  const listeners = new Set<() => void>();
  const publish = (next: CourseMaterialUpload[]) => {
    items = next;
    listeners.forEach((listener) => listener());
  };
  const replace = (item: CourseMaterialUpload) =>
    publish(items.map((current) => (current.id === item.id ? item : current)));
  const forget = (id: string) =>
    publish(
      items.filter((item) => item.id !== id).map((item, index) => ({ ...item, order: index + 1 })),
    );

  async function removeStored(id: string, storageKey: string) {
    try {
      await storage.deleteDocumentBlob(storageKey);
    } catch (error) {
      if (disposed) {
        storage.onCleanupError(error);
      } else {
        publish(
          items.map((current) =>
            current.id === id
              ? {
                  ...current,
                  status: 'completed',
                  storageKey,
                  removing: false,
                  removalError: String(error),
                }
              : current,
          ),
        );
      }
      return;
    }
    if (!disposed) forget(id);
  }

  async function upload(item: CourseMaterialUpload) {
    let storageKey: string;
    try {
      storageKey = await storage.storeDocumentBlob(item.file);
    } catch (error) {
      if (disposed) return;
      const current = items.find((candidate) => candidate.id === item.id);
      if (!current) return;
      if (current.removing) forget(item.id);
      else replace({ ...current, status: 'failed', error: String(error) });
      return;
    }
    const current = items.find((candidate) => candidate.id === item.id);
    if (disposed || !current || current.removing) {
      // An IndexedDB write cannot be aborted here. Delete only after it settles,
      // so a removed file cannot reappear or leave its late blob behind.
      await removeStored(item.id, storageKey);
    } else {
      replace({ ...current, status: 'completed', storageKey });
    }
  }

  return {
    getSnapshot: () => items,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mount() {
      active = true;
      return () => {
        active = false;
        // StrictMode immediately reattaches effects; only a real unmount gives
        // up the draft's blobs. A submitted session owns its transferred keys.
        queueMicrotask(() => {
          if (active || disposed) return;
          disposed = true;
          if (handedOff) return;
          for (const item of items) {
            if (item.status === 'completed' && !item.removing)
              void removeStored(item.id, item.storageKey);
          }
        });
      };
    },
    add(files: File[]) {
      if (disposed || handedOff) return;
      const additions: CourseMaterialUpload[] = dedupeCourseMaterialFiles(items, files).map(
        (file, index) => ({
          id: nanoid(8),
          file,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          type: file.type,
          order: items.length + index + 1,
          status: 'uploading',
        }),
      );
      if (additions.length === 0) return;
      publish([...items, ...additions]);
      additions.forEach((item) => {
        void upload(item);
      });
    },
    retry(id: string) {
      if (disposed || handedOff) return;
      const item = items.find((candidate) => candidate.id === id);
      if (!item || item.status !== 'failed' || item.removing) return;
      const uploading: CourseMaterialUpload = { ...item, status: 'uploading' };
      replace(uploading);
      void upload(uploading);
    },
    remove(id: string) {
      if (disposed || handedOff) return;
      const item = items.find((candidate) => candidate.id === id);
      if (!item || item.removing) return;
      if (item.status === 'failed') {
        forget(id);
        return;
      }
      replace({ ...item, removing: true, removalError: undefined });
      if (item.status === 'completed') void removeStored(item.id, item.storageKey);
    },
    submit(providerId: string, consume: (sources: SessionDocumentSource[]) => void) {
      if (disposed || handedOff) throw new Error('Course material draft is no longer editable');
      const sources = items.map((item): SessionDocumentSource => {
        if (item.status !== 'completed' || item.removing || item.removalError) {
          throw new Error('Course materials are not ready for submission');
        }
        return {
          id: item.id,
          name: item.name,
          size: item.size,
          lastModified: item.lastModified,
          mimeType: normalizeDocumentMimeType({ mimeType: item.type, fileName: item.name }),
          order: item.order,
          storageKey: item.storageKey,
          providerId,
        };
      });
      handedOff = true;
      try {
        consume(sources);
      } catch (error) {
        handedOff = false;
        throw error;
      }
    },
  };
}

export function useCourseMaterials(storage: MaterialStorage) {
  const [uploads] = useState(() => createMaterialUploads(storage));
  const items = useSyncExternalStore(uploads.subscribe, uploads.getSnapshot, () => EMPTY_MATERIALS);
  useEffect(() => uploads.mount(), [uploads]);
  return {
    ...uploads,
    items,
    ready: items.every(
      (item) => item.status === 'completed' && !item.removing && !item.removalError,
    ),
  };
}
