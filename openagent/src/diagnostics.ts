// Error diagnostics + resilient fetch for OpenRouter/free-tier reality.
//
// OpenRouter free (:free) models are shared upstream capacity and frequently
// return HTTP 429 ("temporarily rate-limited upstream") with a Retry-After.
// The Vercel AI SDK surfaces only the top-level "Provider returned error"
// string and hides the real cause in the response body's error.metadata.raw.
// These helpers (a) unwrap that into an actionable message, (b) log clean
// diagnostic lines to the console, and (c) wrap fetch so 429/502/503 and
// network blips are retried (respecting Retry-After) and every request has a
// timeout so a stuck upstream can't hang the pipeline forever.

const REQUEST_TIMEOUT_MS = Number(process.env.LEXIS_OA_REQUEST_TIMEOUT_MS ?? 180_000);
const FETCH_MAX_RETRIES = Number(process.env.LEXIS_OA_FETCH_RETRIES ?? 4);

export function logLine(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[lexis ${ts}] ${tag}: ${msg}`);
}

interface OpenRouterErrorBody {
  error?: { message?: string; code?: number; metadata?: { raw?: string; provider_name?: string; retry_after_seconds?: number } };
  message?: string;
}

/** Unwrap an AI SDK / provider error into a detailed, actionable one-liner. */
export function describeError(error: unknown): string {
  let err = error as Record<string, unknown> | undefined;
  const chain: string[] = [];

  // RetryError wraps the final underlying error and the attempt count.
  if (err && (err.name === 'AI_RetryError' || Array.isArray(err.errors))) {
    const attempts = Array.isArray(err.errors) ? err.errors.length : undefined;
    if (attempts) chain.push(`after ${attempts} attempt(s)`);
    err = (err.lastError as Record<string, unknown>) ?? err;
  }

  // APICallError carries the HTTP status and the provider's response body.
  const statusCode = err?.statusCode as number | undefined;
  const responseBody = (err?.responseBody ?? err?.data) as unknown;
  let detail = '';
  let retryHint: number | undefined;
  if (responseBody != null) {
    let parsed: OpenRouterErrorBody | undefined;
    if (typeof responseBody === 'string') {
      try {
        parsed = JSON.parse(responseBody) as OpenRouterErrorBody;
      } catch {
        detail = responseBody;
      }
    } else if (typeof responseBody === 'object') {
      parsed = responseBody as OpenRouterErrorBody;
    }
    if (parsed?.error) {
      const meta = parsed.error.metadata;
      detail = meta?.raw || parsed.error.message || detail;
      if (meta?.provider_name) detail += ` (upstream: ${meta.provider_name})`;
      retryHint = meta?.retry_after_seconds;
    } else if (parsed?.message) {
      detail = parsed.message;
    }
  }
  if (!detail && err instanceof Error) detail = err.message;
  if (!detail) detail = String(error);

  const head = statusCode ? `HTTP ${statusCode}` : '';
  let msg = [head, ...chain, detail].filter(Boolean).join(' — ');
  if (retryHint) msg += ` (retry-after ${retryHint}s)`;

  // Actionable hints for the common free-tier failure modes.
  if (statusCode === 429 || /rate.?limit|temporarily rate-limited|free-models-per-day/i.test(msg)) {
    msg +=
      '  [OpenRouter free models are shared upstream capacity and get rate-limited; the harness ' +
      'retries with backoff. If it persists, the upstream pool is saturated — try again later, pick ' +
      'a less-busy free model, or add a little OpenRouter credit / your own upstream key. See README.]';
  } else if (statusCode === 401 || /auth|api key|missing authentication/i.test(msg)) {
    msg += '  [set OPENROUTER_API_KEY — https://openrouter.ai/keys]';
  } else if (statusCode === 402 || /insufficient|credit/i.test(msg)) {
    msg += '  [this model needs OpenRouter credits]';
  } else if (statusCode === 404 || /not found|no endpoints|no.*model/i.test(msg)) {
    msg += '  [model id may be unavailable — check models.json against https://openrouter.ai/models]';
  }
  return msg;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A fetch wrapper that times out each attempt and retries 429/5xx and network
 * errors, honoring the Retry-After header. Non-retryable statuses (400/401/
 * 404/…) pass straight through so they fail fast with a clear message.
 */
export function createResilientFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= FETCH_MAX_RETRIES; attempt++) {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      try {
        const resp = await fetch(input as RequestInfo, { ...init, signal });
        if (!RETRYABLE_STATUS.has(resp.status) || attempt === FETCH_MAX_RETRIES) return resp;
        const retryAfter = Number(resp.headers.get('retry-after')) || 0;
        const wait = retryAfter > 0 ? retryAfter * 1000 + 500 : Math.min(2000 * 2 ** attempt, 20_000);
        logLine(
          'rate-limit',
          `HTTP ${resp.status} from upstream; backing off ${Math.round(wait / 1000)}s (retry ${attempt + 1}/${FETCH_MAX_RETRIES})`,
        );
        await sleep(wait);
      } catch (error) {
        // Caller-initiated abort (interrupt) must not be retried.
        if (init?.signal?.aborted) throw error;
        lastError = error;
        if (attempt === FETCH_MAX_RETRIES) throw error;
        const wait = Math.min(2000 * 2 ** attempt, 20_000);
        logLine('network', `${error instanceof Error ? error.message : error}; retry ${attempt + 1}/${FETCH_MAX_RETRIES} in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
    }
    throw lastError;
  };
}
