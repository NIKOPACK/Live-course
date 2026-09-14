import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import { BrowserDocumentStore, BrowserRuntimeStore } from '@livecourse/storage';
import { createStorageHttpHandler } from '@livecourse/storage/server';
import { HttpDocumentStore } from '@livecourse/storage/document/http';
import { makeDocument } from '../../packages/@livecourse/storage/test/document-contract';
import { makeCoursePlan } from '../livecourse/course-plan-fixture';

async function requestFetch(
  handler: RequestListener,
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const body = await request.text();
  const fakeRequest = {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(request.headers.entries()),
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  } as unknown as IncomingMessage;
  return new Promise<Response>((resolve, reject) => {
    let status = 200;
    let headers: Record<string, string> = {};
    let responseBody: string | undefined;
    const response = {
      get headersSent() {
        return true;
      },
      writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
        status = nextStatus;
        headers = nextHeaders ?? {};
        return this;
      },
      end(chunk?: string | Buffer) {
        responseBody = chunk?.toString();
        resolve(new Response(status === 204 ? null : responseBody, { status, headers }));
        return this;
      },
      destroy(error?: Error) {
        reject(error ?? new Error('response destroyed'));
        return this;
      },
    } as unknown as ServerResponse;
    handler(fakeRequest, response);
  });
}

describe('persistence document route course-plan boundary', () => {
  it('round-trips optional course-plan metadata through the HTTP persistence boundary', async () => {
    const documents = new BrowserDocumentStore({ indexedDB: new IDBFactory() });
    const runtime = new BrowserRuntimeStore({ indexedDB: new IDBFactory() });
    const handler = createStorageHttpHandler(runtime, documents, {
      authenticate: async () => ({ learnerKey: 'test-learner' }),
    });
    const client = new HttpDocumentStore({
      baseUrl: 'http://persistence.test',
      fetch: (input, init) => requestFetch(handler, input, init),
    });
    await client.saveDocument({ ...makeDocument(), coursePlan: makeCoursePlan() });

    const loaded = await client.loadDocument('stage-1');
    expect(loaded?.coursePlan).toMatchObject({ schemaVersion: 1, version: 3 });
  });
});
