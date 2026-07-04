"""Error diagnostics + a rate-limit-resilient LiteLLM model.

OpenRouter free (:free) models are shared upstream capacity and frequently
return HTTP 429 ("temporarily rate-limited upstream") with a Retry-After.
LiteLLM raises these as exceptions and prints a noisy provider list. These
helpers quiet that noise, unwrap the real cause into an actionable message,
and retry 429/5xx with Retry-After backoff so a run survives transient limits.
"""

from __future__ import annotations

import logging
import os
import re
import sys
import time

logger = logging.getLogger("lexis")

# Per-request ceiling. Generous, because a free-tier reasoning model can spend
# minutes on one whole-chapter generation; the old 180s cap killed those and then
# retried them (litellm.Timeout used to be retryable), turning one slow call into
# many. (smolagents/LiteLLM here uses non-streaming generate, so a true streaming
# idle-timeout — like the openagent harness — isn't available; this is the ceiling.)
REQUEST_TIMEOUT_S = float(os.environ.get("LEXIS_SMOL_REQUEST_TIMEOUT", "600"))
MODEL_MAX_RETRIES = int(os.environ.get("LEXIS_SMOL_MODEL_RETRIES", "4"))


def quiet_litellm() -> None:
    """Suppress LiteLLM's 'Provider List' / 'Give Feedback' console dumps."""
    try:
        import litellm

        litellm.suppress_debug_info = True
        litellm.set_verbose = False
    except Exception:
        pass


def log_line(tag: str, msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    print(f"[lexis {ts}] {tag}: {msg}", file=sys.stderr, flush=True)


def _retry_after(exc: Exception) -> float | None:
    """Best-effort extraction of a Retry-After hint (seconds) from a litellm error."""
    for attr in ("retry_after",):
        val = getattr(exc, attr, None)
        if isinstance(val, (int, float)) and val > 0:
            return float(val)
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if headers:
        try:
            ra = headers.get("retry-after") or headers.get("Retry-After")
            if ra:
                return float(ra)
        except Exception:
            pass
    m = re.search(r'retry_after_seconds"?\s*[:=]\s*([0-9.]+)', str(exc))
    if m:
        return float(m.group(1))
    return None


def describe_error(exc: BaseException) -> str:
    """Turn a model/tool exception into an actionable one-liner for the UI."""
    text = str(exc).strip()
    # Strip smolagents' generic wrapper prefix.
    text = re.sub(r"^Error while generating output:\s*", "", text)
    # Pull OpenRouter's real upstream message out of the JSON body if present.
    raw = re.search(r'"raw"\s*:\s*"([^"]+)"', text)
    if raw:
        text = raw.group(1)
    provider = re.search(r'"provider_name"\s*:\s*"([^"]+)"', str(exc))
    if provider and provider.group(1) not in text:
        text += f" (upstream: {provider.group(1)})"

    lowered = text.lower()
    if "429" in text or "rate" in lowered and "limit" in lowered or "rate-limited" in lowered:
        text += (
            "  [OpenRouter free models are shared upstream capacity and get rate-limited; the harness "
            "retries with backoff. If it persists, the pool is saturated — try later, pick a less-busy "
            "free model, or add a little OpenRouter credit / your own upstream key. See README.]"
        )
    elif "401" in text or "authentication" in lowered or "api key" in lowered:
        text += "  [set OPENROUTER_API_KEY — https://openrouter.ai/keys]"
    elif "402" in text or "insufficient" in lowered or "credit" in lowered:
        text += "  [this model needs OpenRouter credits]"
    elif "404" in text or "not found" in lowered or "no endpoints" in lowered:
        text += "  [model id may be unavailable — check models.json against https://openrouter.ai/models]"
    return text


def make_litellm_model(spec: dict):
    """Build a LiteLLMModel whose generate() retries 429/5xx with Retry-After
    backoff. We own the single retry layer (retry=False disables smolagents'
    built-in retryer, so 429s don't get double-retried into long stalls)."""
    from smolagents import LiteLLMModel

    quiet_litellm()
    spec.setdefault("timeout", REQUEST_TIMEOUT_S)
    spec.setdefault("retry", False)

    class RetryingLiteLLMModel(LiteLLMModel):
        def _with_retry(self, fn, *args, **kwargs):
            import litellm

            # 429 / 5xx / connection blips are transient and worth retrying. A
            # Timeout is NOT retried: it means the generation exceeded
            # REQUEST_TIMEOUT_S, and re-running it at the same ceiling just
            # multiplies the stall — fail once and let the orchestrator's
            # fail-fast guard handle it.
            retryable = (
                litellm.RateLimitError,
                litellm.InternalServerError,
                litellm.APIConnectionError,
                litellm.ServiceUnavailableError,
            )
            last: Exception | None = None
            for attempt in range(MODEL_MAX_RETRIES + 1):
                try:
                    return fn(*args, **kwargs)
                except retryable as exc:  # type: ignore[misc]
                    last = exc
                    if attempt == MODEL_MAX_RETRIES:
                        raise
                    wait = _retry_after(exc) or min(5 * 2**attempt, 30)
                    log_line(
                        "rate-limit",
                        f"{type(exc).__name__}; backing off {wait:.0f}s "
                        f"(retry {attempt + 1}/{MODEL_MAX_RETRIES})",
                    )
                    time.sleep(wait + 0.5)
            assert last is not None
            raise last

        def generate(self, *args, **kwargs):  # type: ignore[override]
            return self._with_retry(super().generate, *args, **kwargs)

    return RetryingLiteLLMModel(**spec)
