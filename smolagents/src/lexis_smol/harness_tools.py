"""Harness contract tools for the orchestrator — port of the in-process MCP
server in claude/src/orchestrator.ts (report_progress, save_version,
list_versions, revert_version, request_review, mark_complete).

`request_review` blocks inside the tool call on a threading.Event until the
user approves or sends revision instructions from the UI — the same
"gate inside one long turn" shape as the Claude harness.
"""

from __future__ import annotations

import threading
from pathlib import Path

from smolagents import Tool

from .projects import PHASES, Project
from .versioning import list_versions, revert_to_version, save_version


class ReviewGate:
    """One pending review at a time; resolved by the HTTP layer."""

    def __init__(self):
        self._event = threading.Event()
        self._answer: str | None = None
        self._pending = False
        self._lock = threading.Lock()

    @property
    def pending(self) -> bool:
        return self._pending

    def arm(self) -> None:
        with self._lock:
            self._event.clear()
            self._answer = None
            self._pending = True

    def wait(self) -> str:
        self._event.wait()
        with self._lock:
            self._pending = False
            return self._answer or "Session is shutting down; stop."

    def resolve(self, answer: str) -> bool:
        with self._lock:
            if not self._pending:
                return False
            self._answer = answer
            self._event.set()
            return True

    def abort(self) -> None:
        with self._lock:
            if self._pending:
                self._answer = "Session is shutting down; stop."
                self._event.set()


class ReportProgressTool(Tool):
    name = "report_progress"
    description = (
        "Report structured pipeline progress to the user interface. Call whenever a phase or chapter "
        f"changes state. Phases: {', '.join(PHASES)}."
    )
    inputs = {
        "phase": {"type": "string", "description": f"One of: {', '.join(PHASES)}"},
        "state": {"type": "string", "description": "One of: started, completed, failed"},
        "chapter": {"type": "string", "description": "The chapter filename, when chapter-scoped", "nullable": True},
        "detail": {"type": "string", "description": "Optional short detail", "nullable": True},
    }
    output_type = "string"

    def __init__(self, project: Project):
        super().__init__()
        self.project = project

    def forward(self, phase: str, state: str, chapter: str | None = None, detail: str | None = None) -> str:
        if phase not in PHASES:
            return f"Error: unknown phase '{phase}'. Use one of: {', '.join(PHASES)}"
        if state not in ("started", "completed", "failed"):
            return "Error: state must be started, completed or failed"
        data = {"phase": phase, "state": state}
        if chapter:
            data["chapter"] = chapter
        if detail:
            data["detail"] = detail
        self.project.emit("progress", "orchestrator", data)
        return "ok"


class SaveVersionTool(Tool):
    name = "save_version"
    description = "Snapshot the entire workspace as a named version the user can inspect and revert to."
    inputs = {"label": {"type": "string", "description": "Short human-readable label for this version"}}
    output_type = "string"

    def __init__(self, project: Project):
        super().__init__()
        self.project = project

    def forward(self, label: str) -> str:
        version = save_version(self.project, label)
        if version is None:
            return "No changes since the last version; nothing to save."
        return f"Saved version {version['id'][:8]}: {version['label']}"


class ListVersionsTool(Tool):
    name = "list_versions"
    description = "List all saved workspace versions, newest first."
    inputs = {}
    output_type = "string"

    def __init__(self, project: Project):
        super().__init__()
        self.project = project

    def forward(self) -> str:
        versions = list_versions(self.project)
        if not versions:
            return "No versions yet."
        return "\n".join(
            f"{v['id'][:8]}  {v['date']}  {v['label']}{' (auto)' if v['auto'] else ''}" for v in versions
        )


class RevertVersionTool(Tool):
    name = "revert_version"
    description = (
        "Restore the workspace to a previous version. The current state is snapshotted first, so this is "
        "non-destructive."
    )
    inputs = {"id": {"type": "string", "description": "Version id (full or abbreviated commit hash)"}}
    output_type = "string"

    def __init__(self, project: Project):
        super().__init__()
        self.project = project

    def forward(self, id: str) -> str:
        version = revert_to_version(self.project, id)
        return (
            f"Workspace restored. New version {version['id'][:8]}: {version['label']}. "
            "Re-read the workspace before continuing."
        )


class RequestReviewTool(Tool):
    name = "request_review"
    description = (
        "MANDATORY before packaging. Presents your summary to the user and blocks until they approve or "
        "send revision instructions. Returns the decision."
    )
    inputs = {
        "summary": {
            "type": "string",
            "description": "What was translated, glossary/consistency notes, notable challenges, open questions",
        }
    }
    output_type = "string"

    def __init__(self, project: Project, gate: ReviewGate):
        super().__init__()
        self.project = project
        self.gate = gate

    def forward(self, summary: str) -> str:
        self.gate.arm()
        self.project.emit("review_request", "orchestrator", {"summary": summary})
        self.project.set_status("awaiting_review")
        answer = self.gate.wait()
        self.project.set_status("running")
        return answer


class MarkCompleteTool(Tool):
    name = "mark_complete"
    description = "Record that the translated EPUB has been produced. Call exactly once per successful packaging."
    inputs = {
        "epub_path": {"type": "string", "description": "Path to the produced .epub, relative to the project root"},
        "summary": {"type": "string", "description": "One-paragraph completion summary for the user"},
    }
    output_type = "string"

    def __init__(self, project: Project, on_complete):
        super().__init__()
        self.project = project
        self.on_complete = on_complete

    def forward(self, epub_path: str, summary: str) -> str:
        workspace = self.project.workspace.resolve()
        abs_path = (workspace / epub_path).resolve()
        if abs_path != workspace and workspace not in abs_path.parents:
            return "Error: path escapes the workspace."
        if not abs_path.is_file() or abs_path.stat().st_size < 1024:
            return f"No plausible EPUB found at {epub_path} — verify packaging actually succeeded."
        self.project.meta["outputPath"] = str(abs_path.relative_to(workspace))
        self.project.save()
        self.on_complete()
        self.project.emit(
            "progress", "orchestrator", {"phase": "done", "state": "completed", "detail": summary}
        )
        return "Completion recorded."


def build_harness_tools(project: Project, gate: ReviewGate, on_complete) -> list[Tool]:
    return [
        ReportProgressTool(project),
        SaveVersionTool(project),
        ListVersionsTool(project),
        RevertVersionTool(project),
        RequestReviewTool(project, gate),
        MarkCompleteTool(project, on_complete),
    ]
