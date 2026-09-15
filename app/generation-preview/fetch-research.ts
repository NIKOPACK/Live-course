export const GENERATION_WEB_SEARCH_TIMEOUT_MS = 20_000;

export type GenerationResearch = {
  ok: boolean;
  researchContext: string;
  researchSources: Array<{ title: string; url: string }>;
};

const EMPTY_RESEARCH: GenerationResearch = {
  ok: false,
  researchContext: '',
  researchSources: [],
};

function combineAbortSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal.aborted || timeout.aborted) {
    controller.abort();
    return controller.signal;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  timeout.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

/** Optional web search must not block classroom generation. */
export async function fetchGenerationResearch(
  body: Record<string, unknown>,
  headers: HeadersInit,
  signal?: AbortSignal,
): Promise<GenerationResearch> {
  try {
    const res = await fetch('/api/web-search', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combineAbortSignals(signal, GENERATION_WEB_SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) return EMPTY_RESEARCH;
    const searchData = (await res.json()) as {
      context?: string;
      sources?: Array<{ title?: string; url?: string }>;
    };
    const researchSources = (searchData.sources ?? [])
      .filter((source): source is { title: string; url: string } =>
        Boolean(source.title && source.url),
      )
      .map((source) => ({ title: source.title, url: source.url }));
    return {
      ok: true,
      researchContext: searchData.context || '',
      researchSources,
    };
  } catch {
    return EMPTY_RESEARCH;
  }
}
