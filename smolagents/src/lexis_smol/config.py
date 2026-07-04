"""Model tier configuration — the diversification knob of this harness.

The pipeline design is fixed (see docs/LESSONS.md); what varies is which model
fills each tier. `models.json` names tiers and maps them to smolagents Model
constructors; agent frontmatter (`model: translation|mechanical`) selects a
tier, and per-agent overrides allow one-off experiments.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any

HARNESS_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("LEXIS_SMOL_DATA_DIR", HARNESS_DIR / "data"))
MODELS_FILE = Path(os.environ.get("LEXIS_SMOL_MODELS", HARNESS_DIR / "models.json"))

# Fallback per-MTok pricing used when litellm cannot cost a response and the
# config has no entry. Mirrors claude/src/orchestrator.ts MODEL_PRICES.
DEFAULT_PRICING: list[tuple[str, float, float]] = [
    ("opus", 5.0, 25.0),
    ("sonnet", 3.0, 15.0),
    ("haiku", 1.0, 5.0),
]


def load_model_config() -> dict[str, Any]:
    with open(MODELS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


class ModelFactory:
    """Builds one smolagents Model instance per agent, per the tier config."""

    def __init__(self, config: dict[str, Any] | None = None):
        self.config = config or load_model_config()
        self.tiers: dict[str, dict[str, Any]] = self.config.get("tiers", {})
        self.agent_overrides: dict[str, dict[str, Any]] = self.config.get("agent_overrides", {})
        self.pricing: dict[str, dict[str, float]] = self.config.get("pricing", {})

    def spec_for(self, tier: str, agent_name: str | None = None) -> dict[str, Any]:
        if tier not in self.tiers:
            raise KeyError(f"Unknown model tier '{tier}' — define it in {MODELS_FILE}")
        spec = copy.deepcopy(self.tiers[tier])
        # A tier may alias another tier ({"tier": "mechanical"}).
        seen = {tier}
        while "tier" in spec:
            alias = spec.pop("tier")
            if alias in seen:
                raise ValueError(f"Model tier alias cycle at '{alias}'")
            seen.add(alias)
            base = copy.deepcopy(self.tiers[alias])
            base.update(spec)  # alias-local keys win over the base tier
            spec = base
        if agent_name and agent_name in self.agent_overrides:
            spec.update(copy.deepcopy(self.agent_overrides[agent_name]))
        return spec

    def build(self, tier: str, agent_name: str | None = None):
        spec = self.spec_for(tier, agent_name)
        provider = spec.pop("provider", "litellm")
        if provider == "litellm":
            from .diagnostics import make_litellm_model

            return make_litellm_model(spec)
        if provider == "openai":
            from smolagents import OpenAIModel

            return OpenAIModel(**spec)
        if provider == "inference_client":
            from smolagents import InferenceClientModel

            return InferenceClientModel(**spec)
        raise ValueError(f"Unknown model provider '{provider}' (expected litellm|openai|inference_client)")

    def price_per_mtok(self, model_id: str) -> tuple[float, float] | None:
        """(input $/MTok, output $/MTok) for a model, or None if unknown."""
        for key, entry in self.pricing.items():
            if isinstance(entry, dict) and key in model_id:
                return float(entry.get("in", 0.0)), float(entry.get("out", 0.0))
        lowered = model_id.lower()
        for needle, cin, cout in DEFAULT_PRICING:
            if needle in lowered:
                return cin, cout
        return None
