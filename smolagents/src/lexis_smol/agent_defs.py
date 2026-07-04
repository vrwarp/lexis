"""Load the 14 pipeline subagents from smolagents/agents/*.md.

Same file-per-agent shape as the other two harnesses: a small frontmatter
(description, model tier, tools, optional max_steps) followed by the agent's
role instructions. Bodies are carried over verbatim from claude/agents/ — they
are provider-neutral. Agent names use underscores (managed-agent names must be
valid Python identifiers).
"""

from __future__ import annotations

import copy
import importlib.resources
import re
from pathlib import Path
from typing import Any, Callable

import yaml
from smolagents import ToolCallingAgent
from smolagents.monitoring import LogLevel

from .config import HARNESS_DIR, ModelFactory
from .fs_tools import build_toolset

AGENTS_DIR = HARNESS_DIR / "agents"

DEFAULT_SUBAGENT_MAX_STEPS = 30

# Subagents do their work through workspace files; the manager only needs a
# terse status report, not the default three-part managed-agent essay.
MANAGED_TASK_TEMPLATE = """{{task}}

Reminder: you are '{{name}}' in the lexis translation pipeline. Do the work by reading and writing workspace files exactly as your role instructions specify. When the work is done, call final_answer with a concise status report: what you produced or verified, the exact output file paths, and any warnings. Do not paste whole file contents into the final answer."""

MANAGED_REPORT_TEMPLATE = """{{final_answer}}"""


def load_agent_definitions() -> dict[str, dict[str, Any]]:
    defs: dict[str, dict[str, Any]] = {}
    for file in sorted(AGENTS_DIR.glob("*.md")):
        raw = file.read_text(encoding="utf-8")
        match = re.match(r"^---\n(.*?)\n---\n(.*)$", raw, re.S)
        if not match:
            raise ValueError(f"Agent file {file.name} is missing frontmatter")
        frontmatter, prompt = match.group(1), match.group(2)
        fields: dict[str, str] = {}
        for line in frontmatter.splitlines():
            key, sep, value = line.partition(":")
            if sep:
                fields[key.strip()] = value.strip()
        if "description" not in fields or "model" not in fields:
            raise ValueError(f"Agent file {file.name} must declare description and model")
        name = file.stem.replace("-", "_")
        defs[name] = {
            "name": name,
            "description": fields["description"],
            "tier": fields["model"],
            "tools": [t.strip() for t in fields.get("tools", "").split(",") if t.strip()],
            "max_steps": int(fields.get("max_steps", DEFAULT_SUBAGENT_MAX_STEPS)),
            "instructions": prompt.strip(),
        }
    return defs


def _subagent_prompt_templates() -> dict[str, Any]:
    templates = yaml.safe_load(
        importlib.resources.files("smolagents.prompts").joinpath("toolcalling_agent.yaml").read_text()
    )
    templates = copy.deepcopy(templates)
    templates["managed_agent"]["task"] = MANAGED_TASK_TEMPLATE
    templates["managed_agent"]["report"] = MANAGED_REPORT_TEMPLATE
    return templates


def build_subagents(
    workspace: Path,
    factory: ModelFactory,
    step_callbacks_for: Callable[[str], dict | list] | None = None,
    agent_cls: type[ToolCallingAgent] = ToolCallingAgent,
) -> list[ToolCallingAgent]:
    """Instantiate the 14 subagents as managed agents (fresh memory per call)."""
    agents = []
    for spec in load_agent_definitions().values():
        callbacks = step_callbacks_for(spec["name"]) if step_callbacks_for else None
        agent = agent_cls(
            name=spec["name"],
            description=spec["description"],
            instructions=spec["instructions"],
            tools=build_toolset(workspace, spec["tools"]),
            model=factory.build(spec["tier"], spec["name"]),
            prompt_templates=_subagent_prompt_templates(),
            max_steps=spec["max_steps"],
            max_tool_threads=1,
            verbosity_level=LogLevel.ERROR,
            step_callbacks=callbacks,
            provide_run_summary=False,
        )
        agents.append(agent)
    return agents
