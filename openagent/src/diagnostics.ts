// Error diagnostics + resilient fetch for OpenRouter/free-tier reality.
//
// OpenRouter free (:free) models are shared upstream capacity and frequently
// return HTTP 429 ("temporarily rate-limited upstream") with a Retry-After.
// The Vercel AI SDK surfaces only the top-level "Provider returned error"
// string and hides the real cause in the response body's error.metadata.raw.
// These helpers (a) unwrap that into an actionable message, (b) log clean
// diagnostic lines to the console, and (c) wrap fetch so 429/502/503 and
// network blips are retried (respecting Retry-After) and every request has an
// IDLE timeout — a silent/stuck upstream is killed, but a response that keeps
// streaming tokens (slow reasoning models) is never cut off mid-generation.

// Absolute per-attempt backstop: a request that never completes at all dies
// after this. It is deliberately generous, because the real guard is the idle
// timeout below — free-tier reasoning models can legitimately stream for minutes.
const REQUEST_TIMEOUT_MS = Number(process.env.LEXIS_OA_REQUEST_TIMEOUT_MS ?? 900_000);
// Idle timeout: abort only if NO bytes arrive for this long (covers connect,
// time-to-first-token, and mid-stream stalls). A generation that keeps emitting
// tokens resets it on every chunk, so a slow-but-alive call is never killed —
// this is what fixes the 180s "operation aborted due to timeout" on long outputs.
const STREAM_IDLE_MS = Number(process.env.LEXIS_OA_STREAM_IDLE_MS ?? 180_000);
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
 * A fetch wrapper that gives every request an IDLE timeout (reset on each
 * streamed byte, so a progressing response never times out) plus a generous
 * absolute backstop, and retries 429/5xx and pre-response network errors,
 * honoring the Retry-After header. Non-retryable statuses (400/401/404/…) pass
 * straight through so they fail fast with a clear message.
 *
 * The idle timeout is the key to running reasoning models on the free tier: a
 * single generation can legitimately take minutes, and a total-request timeout
 * would kill it (and, worse, retry it). Here the request lives as long as tokens
 * keep arriving; only genuine silence (no bytes for STREAM_IDLE_MS) aborts it.
 */
export function createResilientFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= FETCH_MAX_RETRIES; attempt++) {
      const idle = new AbortController();
      let idleTimer!: ReturnType<typeof setTimeout>;
      const armIdle = () => {
        idleTimer = setTimeout(
          () => idle.abort(new DOMException('no data received before the idle timeout', 'TimeoutError')),
          STREAM_IDLE_MS,
        );
        (idleTimer as unknown as { unref?: () => void }).unref?.();
      };
      const resetIdle = () => {
        clearTimeout(idleTimer);
        armIdle();
      };
      armIdle();
      const backstop = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal = AbortSignal.any([idle.signal, backstop, ...(init?.signal ? [init.signal] : [])]);
      signal.addEventListener('abort', () => clearTimeout(idleTimer), { once: true });
      try {
        const resp = await fetch(input as RequestInfo, { ...init, signal });
        if (RETRYABLE_STATUS.has(resp.status) && attempt < FETCH_MAX_RETRIES) {
          clearTimeout(idleTimer);
          const retryAfter = Number(resp.headers.get('retry-after')) || 0;
          const wait = retryAfter > 0 ? retryAfter * 1000 + 500 : Math.min(2000 * 2 ** attempt, 20_000);
          logLine(
            'rate-limit',
            `HTTP ${resp.status} from upstream; backing off ${Math.round(wait / 1000)}s (retry ${attempt + 1}/${FETCH_MAX_RETRIES})`,
          );
          await sleep(wait);
          continue;
        }
        if (!resp.body) {
          clearTimeout(idleTimer);
          return resp;
        }
        // Reset the idle timer on every chunk: while tokens keep streaming the
        // request lives; a silent stall (no bytes for STREAM_IDLE_MS) aborts it.
        resetIdle();
        const body = resp.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              resetIdle();
              controller.enqueue(chunk);
            },
            flush() {
              clearTimeout(idleTimer);
            },
          }),
        );
        // undici has already decoded the body; strip length/encoding so the
        // re-streamed Response isn't mis-measured or double-decoded downstream.
        const headers = new Headers(resp.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        return new Response(body, { status: resp.status, statusText: resp.statusText, headers });
      } catch (error) {
        clearTimeout(idleTimer);
        // A caller-initiated abort (interrupt) must not be retried. A mid-stream
        // stall surfaces after this function has already returned the Response, so
        // it is never retried here either — only pre-response failures (connect
        // stalls, network blips, an idle/backstop before headers) get another try.
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
