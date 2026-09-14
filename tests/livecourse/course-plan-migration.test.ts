import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { PGlite } from '../../packages/@livecourse/storage/test/pglite-helper';

import {
  BrowserDocumentStore,
  CoursePlanMigrationError,
  PgDocumentStore,
  ensureDocumentSchema,
  migrateCoursePlan,
  type PgDocumentStoreOptions,
} from '@livecourse/storage';
import { makeCoursePlan } from './course-plan-fixture';
import { makeDocument } from '../../packages/@livecourse/storage/test/document-contract';

function documentWithPlan() {
  return { ...makeDocument(), coursePlan: makeCoursePlan() };
}

async function restampBrowserPlan(
  idb: IDBFactory,
  dbName: string,
  value: Record<string, unknown>,
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open(dbName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('course-plans', 'readwrite');
    const request = transaction.objectStore('course-plans').get('stage-1');
    request.onsuccess = () => {
      transaction.objectStore('course-plans').put({ stageId: 'stage-1', coursePlan: value });
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

function pgOptions(db: PGlite): PgDocumentStoreOptions {
  return { withTransaction: (body) => db.transaction((tx) => body(tx)) };
}

/**
 * The PGlite + IndexedDB integration case boots real SQLite-in-WASM and a
 * fake-indexeddb database in one test. Under full-suite load it intermittently
 * exceeds Vitest's 5 s default while passing in isolation, so it gets a named,
 * explicit bounded per-test timeout instead of a global config change.
 */
const PG_BROWSER_INTEGRATION_TIMEOUT_MS = 20_000;

describe('course-plan persistence migration', () => {
  it(
    'migrates the same legacy course-plan version in BrowserDocumentStore and PgDocumentStore',
    async () => {
      const browserIdb = new IDBFactory();
      const browser = new BrowserDocumentStore({
        indexedDB: browserIdb,
        dbName: 'course-plan-migration-browser',
      });
      await browser.saveDocument(documentWithPlan());
      const legacy = { ...makeCoursePlan() } as Record<string, unknown>;
      delete legacy.schemaVersion;
      await restampBrowserPlan(browserIdb, 'course-plan-migration-browser', legacy);

      const db = new PGlite();
      await db.waitReady;
      await ensureDocumentSchema(db);
      const pg = new PgDocumentStore(db, pgOptions(db));
      await pg.saveDocument(documentWithPlan());
      await db.query('UPDATE document_course_plans SET data = $2::jsonb WHERE stage_id = $1', [
        'stage-1',
        JSON.stringify(legacy),
      ]);

      await expect(browser.loadDocument('stage-1')).resolves.toMatchObject({
        coursePlan: { schemaVersion: 1, version: 3 },
      });
      await expect(pg.loadDocument('stage-1')).resolves.toMatchObject({
        coursePlan: { schemaVersion: 1, version: 3 },
      });
      await db.close();
    },
    PG_BROWSER_INTEGRATION_TIMEOUT_MS,
  );

  it('rejects unversioned writes and records without a migration path', async () => {
    const idb = new IDBFactory();
    const store = new BrowserDocumentStore({ indexedDB: idb, dbName: 'course-plan-write-guard' });
    const unversioned = documentWithPlan();
    delete (unversioned.coursePlan as Record<string, unknown>).schemaVersion;
    await expect(store.saveDocument(unversioned)).rejects.toBeInstanceOf(CoursePlanMigrationError);

    await store.saveDocument(documentWithPlan());
    await restampBrowserPlan(idb, 'course-plan-write-guard', {
      ...makeCoursePlan(),
      schemaVersion: 99,
    });
    await expect(store.loadDocument('stage-1')).rejects.toMatchObject({
      name: 'CoursePlanMigrationError',
      reason: 'unsupported',
    });
    expect(() => migrateCoursePlan({ version: 3 }, 'stage-1')).toThrow(/malformed/i);
  });
});
