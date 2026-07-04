"""The long-lived interactive orchestrator session — port of
claude/src/orchestrator.ts onto smolagents.

Substrate mapping (see docs/SMOLAGENTS_ANALYSIS.md):
- streaming-input query()        -> inbox queue + agent.run(msg, reset=False) per turn
- Task tool + agents option      -> managed agents (fresh memory per call)
- SDK messages -> UiEvents       -> step callbacks on every agent
- mid-run user messages          -> inbox drained between steps into the last observation
- SDK context compaction         -> bounded-memory pruning of old observations
- session resume                 -> compact memory persistence (orchestrator_memory.json)
- modelUsage/costUSD             -> per-step TokenUsage + litellm cost / pricing table
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
from typing import Any

from smolagents import ToolCallingAgent
from smolagents.memory import ActionStep, FinalAnswerStep, PlanningStep, TaskStep, ToolCall
from smolagents.monitoring import LogLevel, Timing

from .agent_defs import build_subagents
from .config import ModelFactory
from .fs_tools import build_toolset
from .harness_tools import ReviewGate, build_harness_tools
from .projects import Project
from .prompt import orchestrator_instructions
from .versioning import save_version

ORCH_MAX_STEPS = int(os.environ.get("LEXIS_SMOL_ORCH_MAX_STEPS", "500"))
# Bounded memory: observations of steps older than this many steps are truncated.
PRUNE_KEEP_RECENT = int(os.environ.get("LEXIS_SMOL_KEEP_RECENT_STEPS", "12"))
PRUNE_OBS_CHARS = int(os.environ.get("LEXIS_SMOL_PRUNED_OBS_CHARS", "1500"))
USAGE_EMIT_INTERVAL = 10.0  # seconds between usage events
MEMORY_PERSIST_EVERY = 5  # orchestrator steps between memory snapshots

HARNESS_TOOL_NAMES = {
    "report_progress",
    "save_version",
    "list_versions",
    "revert_version",
    "request_review",
    "mark_complete",
}


def _summarize_input(arguments: Any) -> Any:
    """Trim long values for tool_use events (mirror of summarizeInput in the Claude harness)."""
    if isinstance(arguments, dict):
        out = {}
        for key, value in arguments.items():
            if isinstance(value, str) and len(value) > 400:
                out[key] = value[:400] + f" … ({len(value)} chars)"
            else:
                out[key] = value
        return out
    if isinstance(arguments, str) and len(arguments) > 400:
        return arguments[:400] + f" … ({len(arguments)} chars)"
    return arguments


class OrchestratorSession:
    def __init__(self, project: Project, factory: ModelFactory | None = None):
        self.project = project
        self.factory = factory or ModelFactory()
        self.gate = ReviewGate()
        self.inbox: "queue.Queue[str]" = queue.Queue()
        self.closed = False
        self._thread: threading.Thread | None = None
        self._thread_lock = threading.Lock()
        self._running = False
        self._completed_this_turn = False
        self._usage_lock = threading.Lock()
        self._last_usage_emit = 0.0
        self._orch_steps_since_persist = 0
        self.agent = self._build_agent()
        self._restore_memory()

    # ---------- construction ----------

    def _build_agent(self) -> ToolCallingAgent:
        project = self.project
        session = self

        class EventedSubagent(ToolCallingAgent):
            """Managed agent that emits task_start/task_end around each invocation."""

            def __call__(self, task: str, **kwargs):
                project.emit(
                    "task_start",
                    "orchestrator",
                    {"agent": self.name, "description": str(task)[:300]},
                )
                try:
                    return super().__call__(task, **kwargs)
                finally:
                    project.emit("task_end", "orchestrator", {"agent": self.name})

        subagents = build_subagents(
            project.workspace,
            self.factory,
            step_callbacks_for=lambda name: {
                ActionStep: [self._on_step],
                PlanningStep: [self._on_step],
            },
            agent_cls=EventedSubagent,
        )
        tools = build_toolset(
            project.workspace, ["read_file", "write_file", "edit_file", "glob", "grep", "bash"]
        ) + build_harness_tools(project, self.gate, self._on_complete)
        return ToolCallingAgent(
            tools=tools,
            managed_agents=subagents,
            model=self.factory.build("orchestrator", "orchestrator"),
            instructions=orchestrator_instructions(project.meta),
            max_steps=ORCH_MAX_STEPS,
            max_tool_threads=1,
            verbosity_level=LogLevel.ERROR,
            step_callbacks={ActionStep: [self._on_step], PlanningStep: [self._on_step]},
        )

    def _on_complete(self) -> None:
        self._completed_this_turn = True

    # ---------- public API (mirrors the Claude harness session) ----------

    @property
    def running(self) -> bool:
        return self._running

    @property
    def awaiting_review(self) -> bool:
        return self.gate.pending

    def send(self, text: str) -> None:
        """Push a user message into the live session (starting it if needed)."""
        self.project.emit("user_message", "user", {"text": text})
        self.inbox.put(text)
        self._ensure_thread()
        if self._running:
            self.project.set_status("running")

    def resolve_review(self, decision: str, instructions: str | None = None) -> bool:
        if not self.gate.pending:
            return False
        self.project.emit("review_response", "user", {"decision": decision, "instructions": instructions})
        if decision == "approve":
            answer = "APPROVED — proceed with packaging."
        else:
            answer = (
                "REVISION REQUESTED — do not package yet. The user's instructions:\n\n"
                f"{instructions or '(none given)'}\n\n"
                "Apply these, save a version, then call request_review again."
            )
        return self.gate.resolve(answer)

    def interrupt(self) -> None:
        self.agent.interrupt()
        for sub in self.agent.managed_agents.values():
            sub.interrupt()
        self.gate.abort()

    def close(self) -> None:
        self.closed = True
        self.interrupt()
        self.inbox.put("")  # unblock the loop

    # ---------- session thread ----------

    def _ensure_thread(self) -> None:
        with self._thread_lock:
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(
                    target=self._loop, name=f"lexis-{self.project.meta['id']}", daemon=True
                )
                self._thread.start()

    def _loop(self) -> None:
        while not self.closed:
            try:
                task = self.inbox.get(timeout=1.0)
            except queue.Empty:
                continue
            if self.closed or not task:
                continue
            self._run_turn(task)

    def _run_turn(self, task: str) -> None:
        project = self.project
        project.set_status("running")
        self._running = True
        self._completed_this_turn = False
        try:
            result = self.agent.run(task, reset=False)
            text = result if isinstance(result, str) else json.dumps(result, default=str)
            if text and text.strip():
                project.emit("agent_text", "orchestrator", {"text": text.strip()})
        except Exception as error:  # noqa: BLE001 — a turn must never kill the session thread
            message = str(error)
            if "interrupted" in message.lower():
                project.emit("status", "orchestrator", {"status": "interrupted", "detail": "Run interrupted."})
            else:
                project.set_status("error", message)
                project.emit("error", "orchestrator", {"message": message})
        finally:
            self._running = False
            # Auto checkpoint at every turn boundary — cheap, and a no-op when
            # nothing changed.
            try:
                save_version(project, "checkpoint (turn end)", auto=True)
            except Exception:
                pass
            self._persist_memory()
            self._emit_usage(force=True)
            if project.meta.get("status") in ("running", "awaiting_review"):
                if self._completed_this_turn:
                    project.set_status("completed")
                elif self.inbox.empty():
                    project.set_status("awaiting_input")

    # ---------- step callback: events, steering, pruning, usage ----------

    def _on_step(self, memory_step, agent=None) -> None:
        project = self.project
        is_orchestrator = agent is self.agent
        label = "orchestrator" if is_orchestrator else (getattr(agent, "name", None) or "subagent")

        if isinstance(memory_step, (ActionStep, PlanningStep)):
            self._track_usage(agent, memory_step)

        if isinstance(memory_step, PlanningStep):
            if memory_step.plan:
                project.emit("thinking", label, {"text": memory_step.plan[:4000]})
            return

        if not isinstance(memory_step, ActionStep):
            return

        # Assistant prose (the ReAct thought preceding the tool calls).
        text = memory_step.model_output
        if isinstance(text, str) and text.strip():
            project.emit("agent_text", label, {"text": text.strip()})

        # Tool calls -> events. Managed-agent calls emit task_start/task_end from
        # the subagent wrapper; harness tools emit their own dedicated events.
        managed_names = set(self.agent.managed_agents.keys()) if is_orchestrator else set()
        for tool_call in memory_step.tool_calls or []:
            if tool_call.name in managed_names or tool_call.name in HARNESS_TOOL_NAMES:
                continue
            if tool_call.name == "final_answer":
                continue
            project.emit(
                "tool_use", label, {"tool": tool_call.name, "input": _summarize_input(tool_call.arguments)}
            )

        if memory_step.error is not None:
            project.emit("error", label, {"message": str(memory_step.error)})

        # Free the heaviest per-step payload: the full input-message snapshot.
        memory_step.model_input_messages = None

        if is_orchestrator:
            self._drain_inbox_into(memory_step)
            self._prune_memory()
            self._orch_steps_since_persist += 1
            if self._orch_steps_since_persist >= MEMORY_PERSIST_EVERY:
                self._persist_memory()

    def _drain_inbox_into(self, memory_step: ActionStep) -> None:
        """Mid-run steering: queued user messages ride into the step observation,
        so the model sees them before its next action."""
        drained = []
        while True:
            try:
                drained.append(self.inbox.get_nowait())
            except queue.Empty:
                break
        drained = [d for d in drained if d]
        if not drained:
            return
        note = "\n\n".join(f"[New user message received mid-run — fold it into your plan now]\n{d}" for d in drained)
        memory_step.observations = ((memory_step.observations or "") + "\n\n" + note).strip()

    def _prune_memory(self) -> None:
        """smolagents replays all steps forever; truncate old observations so a
        book-length run stays bounded. Durable state lives in notes/ on disk."""
        steps = [s for s in self.agent.memory.steps if isinstance(s, ActionStep)]
        for step in steps[:-PRUNE_KEEP_RECENT] if len(steps) > PRUNE_KEEP_RECENT else []:
            if step.observations and len(step.observations) > PRUNE_OBS_CHARS:
                step.observations = (
                    step.observations[:PRUNE_OBS_CHARS]
                    + "\n… (older observation truncated — re-read workspace files if you need the details)"
                )

    # ---------- usage & cost ----------

    def _track_usage(self, agent, memory_step) -> None:
        usage = getattr(memory_step, "token_usage", None)
        if usage is None or agent is None:
            return
        model_id = getattr(agent.model, "model_id", None) or "unknown"
        cost = self._step_cost(model_id, memory_step, usage)
        with self._usage_lock:
            totals = self.project.meta.setdefault("usage", {"byModel": {}, "totalCostUsd": 0.0})
            entry = totals["byModel"].setdefault(
                model_id,
                {
                    "inputTokens": 0,
                    "outputTokens": 0,
                    "cacheReadInputTokens": 0,
                    "cacheCreationInputTokens": 0,
                    "costUsd": 0.0,
                },
            )
            entry["inputTokens"] += usage.input_tokens or 0
            entry["outputTokens"] += usage.output_tokens or 0
            entry["costUsd"] += cost
            totals["totalCostUsd"] += cost
        self._emit_usage()

    def _step_cost(self, model_id: str, memory_step, usage) -> float:
        # Authoritative cost from the raw provider response when litellm can price it.
        raw = getattr(getattr(memory_step, "model_output_message", None), "raw", None)
        if raw is not None:
            try:
                import litellm

                return float(litellm.completion_cost(completion_response=raw))
            except Exception:
                pass
        price = self.factory.price_per_mtok(model_id)
        if not price:
            return 0.0
        return ((usage.input_tokens or 0) * price[0] + (usage.output_tokens or 0) * price[1]) / 1_000_000

    def _emit_usage(self, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._last_usage_emit < USAGE_EMIT_INTERVAL:
            return
        self._last_usage_emit = now
        with self._usage_lock:
            totals = self.project.meta.get("usage") or {"byModel": {}, "totalCostUsd": 0.0}
            snapshot = json.loads(json.dumps(totals))
            self.project.save()
        self.project.emit(
            "usage",
            "orchestrator",
            {"byModel": snapshot["byModel"], "totalCostUsd": snapshot["totalCostUsd"], "live": not force},
        )

    # ---------- memory persistence (session resume) ----------

    def _persist_memory(self) -> None:
        self._orch_steps_since_persist = 0
        steps_out: list[dict[str, Any]] = []
        for step in self.agent.memory.steps:
            if isinstance(step, TaskStep):
                steps_out.append({"kind": "task", "task": step.task})
            elif isinstance(step, ActionStep):
                observations = step.observations or ""
                if step.error is not None:
                    observations = (observations + f"\n[error] {step.error}").strip()
                steps_out.append(
                    {
                        "kind": "action",
                        "model_output": step.model_output if isinstance(step.model_output, str) else None,
                        "tool_calls": [
                            {"name": tc.name, "arguments": _summarize_input(tc.arguments)}
                            for tc in step.tool_calls or []
                        ],
                        "observations": observations or None,
                    }
                )
        try:
            self.project.memory_file.write_text(
                json.dumps(steps_out, ensure_ascii=False, default=str), encoding="utf-8"
            )
        except Exception:
            pass

    def _restore_memory(self) -> None:
        file = self.project.memory_file
        if not file.exists():
            return
        try:
            data = json.loads(file.read_text(encoding="utf-8"))
        except Exception:
            return
        steps = self.agent.memory.steps
        for i, item in enumerate(data):
            if item.get("kind") == "task":
                steps.append(TaskStep(task=item.get("task", "")))
            elif item.get("kind") == "action":
                step = ActionStep(step_number=i, timing=Timing(start_time=0.0, end_time=0.0))
                step.model_output = item.get("model_output")
                step.observations = item.get("observations")
                step.tool_calls = [
                    ToolCall(name=tc.get("name", "?"), arguments=tc.get("arguments"), id=f"restored_{i}_{j}")
                    for j, tc in enumerate(item.get("tool_calls", []))
                ]
                steps.append(step)


_sessions: dict[str, OrchestratorSession] = {}
_sessions_lock = threading.Lock()


def session_for(project: Project) -> OrchestratorSession:
    with _sessions_lock:
        session = _sessions.get(project.meta["id"])
        if session is None:
            session = OrchestratorSession(project)
            _sessions[project.meta["id"]] = session
        return session


def peek_session(project: Project) -> OrchestratorSession | None:
    """Existing session or None — for read-only paths that must not pay for
    (or fail on) model construction."""
    with _sessions_lock:
        return _sessions.get(project.meta["id"])
