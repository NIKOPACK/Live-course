import 'fake-indexeddb/auto';

import { createRequire } from 'node:module';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import { IDBFactory } from 'fake-indexeddb';
import { BrowserRuntimeStore, type RuntimeStore } from '@livecourse/storage';
import { HttpRuntimeStore } from '@livecourse/storage/runtime/http';
import { PgRuntimeStore, ensureSchema, type Queryable } from '@livecourse/storage/runtime/pg';
import { createRuntimeHttpHandler } from '@livecourse/storage/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createCourseMemoryRepository,
  persistGenerationCourseIntake,
} from '@/lib/livecourse/memory';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';
import { runMemoryStoreContract } from './memory-store-contract';

const BASE_URL = 'http://memory-runtime.invalid';

function browserStore(): RuntimeStore {
  return new BrowserRuntimeStore({
    dbName: `memory-contract-${crypto.randomUUID()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
}

function handlerFetch(
  handler: RequestListener,
  authorizationFor: (request: Request) => Promise<string>,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const authorization = await authorizationFor(request);
    const body = await request.text();
    const headers = Object.fromEntries(request.headers.entries());
    headers.authorization = authorization;

    const fakeRequest = {
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers,
      async *[Symbol.asyncIterator]() {
        if (body !== '') yield Buffer.from(body);
      },
    } as unknown as IncomingMessage;

    return new Promise<Response>((resolve, reject) => {
      let status = 200;
      let responseHeaders: Record<string, string> = {};
      const fakeResponse = {
        headersSent: false,
        writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
          status = nextStatus;
          responseHeaders = nextHeaders ?? {};
          this.headersSent = true;
          return this;
        },
        end(chunk?: string | Buffer) {
          resolve(
            new Response(
              status === 204 ? null : chunk === undefined ? undefined : chunk.toString(),
              {
                status,
                headers: responseHeaders,
              },
            ),
          );
          return this;
        },
        destroy(error?: Error) {
          reject(error ?? new Error('response destroyed'));
          return this;
        },
      } as unknown as ServerResponse;

      try {
        handler(fakeRequest, fakeResponse);
      } catch (error) {
        reject(error);
      }
    });
  };
}

async function credentialFor(request: Request, store: RuntimeStore): Promise<string> {
  const path = new URL(request.url).pathname;
  if (request.method === 'POST' && path === '/runtime/sessions') {
    const body = (await request.clone().json()) as { learnerKey?: string };
    return `Bearer ${body.learnerKey || 'invalid'}`;
  }
  const listed = path.match(/^\/runtime\/stages\/[^/]+\/learners\/([^/]+)/)?.[1];
  if (listed !== undefined) return `Bearer ${decodeURIComponent(listed)}`;
  const sessionId = path.match(/^\/runtime\/sessions\/([^/]+)/)?.[1];
  if (sessionId !== undefined) {
    const session = await store.getSession(decodeURIComponent(sessionId));
    if (session !== undefined) return `Bearer ${session.learnerKey}`;
  }
  return 'Bearer contract-operator';
}

function httpStore(): RuntimeStore {
  const backing = new BrowserRuntimeStore({
    indexedDB: new IDBFactory(),
    dbName: `memory-http-${crypto.randomUUID()}`,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  const handler = createRuntimeHttpHandler(backing, {
    authenticate: async (req) => {
      const authorization = req.headers.authorization;
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
        return undefined;
      }
      const learnerKey = authorization.slice('Bearer '.length);
      return learnerKey === '' ? undefined : { learnerKey };
    },
    authorizeMerge: async () => true,
    authorizeAdmin: async () => true,
    payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
  });
  return new HttpRuntimeStore({
    baseUrl: BASE_URL,
    fetch: handlerFetch(handler, (request) => credentialFor(request, backing)),
  });
}

runMemoryStoreContract('IndexedDB', browserStore);
runMemoryStoreContract('HTTP', httpStore);

describe('unconfigured Postgres does not block the local classroom path', () => {
  it('still writes C through IndexedDB when DATABASE_URL / PG_CONTRACT_URL are unset', async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousPgContractUrl = process.env.PG_CONTRACT_URL;
    delete process.env.DATABASE_URL;
    delete process.env.PG_CONTRACT_URL;
    try {
      const store = browserStore();
      await persistGenerationCourseIntake({
        store,
        stageId: 'stage-local',
        learnerId: 'learner-local',
        courseId: 'course-local',
        intake: {
          requirement: '本地课堂不依赖 Postgres',
          preClassAnswers: [],
          finalScope: ['本地课堂不依赖 Postgres'],
          skipped: true,
          submittedAt: '2026-09-14T12:00:00.000Z',
        },
        now: () => '2026-09-14T12:00:00.000Z',
      });
      expect(
        (
          await createCourseMemoryRepository({
            store,
            scope: {
              stageId: 'stage-local',
              learnerId: 'learner-local',
              courseId: 'course-local',
            },
          }).load()
        )?.intake?.requirement,
      ).toBe('本地课堂不依赖 Postgres');
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousPgContractUrl === undefined) delete process.env.PG_CONTRACT_URL;
      else process.env.PG_CONTRACT_URL = previousPgContractUrl;
    }
  });
});

function loadPglite(): typeof import('@electric-sql/pglite') | undefined {
  try {
    const require = createRequire(
      fileURLToPath(new URL('../../../packages/@livecourse/storage/package.json', import.meta.url)),
    );
    return require('@electric-sql/pglite') as typeof import('@electric-sql/pglite');
  } catch {
    return undefined;
  }
}

const pglite = loadPglite();

describe.skipIf(!pglite)('A6 memory contract: Postgres (PGlite)', () => {
  const { PGlite } = pglite!;
  let db: InstanceType<typeof PGlite>;
  let store: RuntimeStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureSchema(db);
    store = new PgRuntimeStore(db, {
      withTransaction: (body) => db.transaction((tx) => body(tx)),
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    });
  });
  afterEach(async () => {
    await db.close();
  });

  runMemoryStoreContract('PGlite', () => store);
});

const pgContractUrl = process.env.PG_CONTRACT_URL;

describe.skipIf(!pgContractUrl)('A6 memory contract: PostgreSQL', () => {
  let pool: import('pg').Pool;
  let store: RuntimeStore;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: pgContractUrl, max: 4 });
    await ensureSchema(pool as Queryable);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE runtime_records, runtime_sessions');
    store = new PgRuntimeStore(pool as Queryable, {
      withTransaction: async (body) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await body(client as Queryable);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch {
            // Preserve the transaction body's original error.
          }
          throw error;
        } finally {
          client.release();
        }
      },
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    });
  });
  afterAll(async () => {
    await pool.end();
  });

  runMemoryStoreContract('PostgreSQL', () => store);
});
