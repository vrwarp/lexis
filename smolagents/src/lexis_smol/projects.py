"""Project store and event log — port of claude/src/projects.ts.

One project = one directory under data/projects/<id>/ holding project.json,
events.jsonl, and workspace/ (a git repository seeded with source.epub, which
doubles as the versioning mechanism).
"""

from __future__ import annotations

import json
import secrets
import subprocess
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .config import DATA_DIR
from .epub import extract_epub, generate_contents

PROJECTS_DIR = DATA_DIR / "projects"

PHASES = ["preparation", "initialization", "extraction", "production", "review", "packaging", "done"]

Listener = Callable[[dict[str, Any]], None]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class Project:
    def __init__(self, meta: dict[str, Any]):
        self.meta = meta
        self._listeners: set[Listener] = set()
        self._lock = threading.Lock()
        self._seq = 0
        events = self.read_events()
        if events:
            self._seq = events[-1]["seq"]

    # ---------- paths ----------

    @property
    def dir(self) -> Path:
        return PROJECTS_DIR / self.meta["id"]

    @property
    def workspace(self) -> Path:
        """The agents' working directory — everything the pipeline touches lives here."""
        return self.dir / "workspace"

    @property
    def events_file(self) -> Path:
        return self.dir / "events.jsonl"

    @property
    def memory_file(self) -> Path:
        return self.dir / "orchestrator_memory.json"

    # ---------- persistence ----------

    def save(self) -> None:
        self.meta["updatedAt"] = _now()
        with self._lock:
            (self.dir / "project.json").write_text(json.dumps(self.meta, indent=2), encoding="utf-8")

    def set_status(self, status: str, detail: str | None = None) -> None:
        if self.meta.get("status") == status:
            return
        self.meta["status"] = status
        if status == "error" and detail:
            self.meta["lastError"] = detail
        self.save()
        self.emit("status", "orchestrator", {"status": status, "detail": detail})

    # ---------- events ----------

    def emit(self, type_: str, agent: str, data: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self._seq += 1
            event = {"seq": self._seq, "ts": _now(), "type": type_, "agent": agent, "data": data}
            with open(self.events_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
        for listener in list(self._listeners):
            try:
                listener(event)
            except Exception:
                pass  # a broken websocket must not break the pipeline
        return event

    def subscribe(self, listener: Listener) -> Callable[[], None]:
        self._listeners.add(listener)
        return lambda: self._listeners.discard(listener)

    def read_events(self, after_seq: int = 0) -> list[dict[str, Any]]:
        if not self.events_file.exists():
            return []
        events = []
        for line in self.events_file.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                event = json.loads(line)
                if event.get("seq", 0) > after_seq:
                    events.append(event)
            except json.JSONDecodeError:
                pass  # skip corrupt lines
        return events


_projects: dict[str, Project] = {}


def _load_from_disk() -> None:
    if not PROJECTS_DIR.exists():
        return
    for entry in PROJECTS_DIR.iterdir():
        meta_file = entry / "project.json"
        if not meta_file.exists():
            continue
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            # A server restart interrupts any in-flight run.
            if meta.get("status") in ("running", "awaiting_review"):
                meta["status"] = "awaiting_input"
            _projects[meta["id"]] = Project(meta)
        except Exception:
            pass  # skip corrupt projects


def list_projects() -> list[Project]:
    return sorted(_projects.values(), key=lambda p: p.meta.get("createdAt", ""), reverse=True)


def get_project(project_id: str) -> Project | None:
    return _projects.get(project_id)


def create_project(
    *, name: str, target_language: str, context: str, epub_bytes: bytes, epub_filename: str
) -> Project:
    project_id = secrets.token_hex(6)
    now = _now()
    meta = {
        "id": project_id,
        "name": name,
        "targetLanguage": target_language,
        "context": context,
        "status": "created",
        "createdAt": now,
        "updatedAt": now,
        "epubFilename": epub_filename,
    }
    project = Project(meta)
    project.workspace.mkdir(parents=True, exist_ok=True)
    (project.workspace / "source.epub").write_bytes(epub_bytes)
    # Extract the source deterministically up front so `original/` is always
    # complete before any agent runs (never trust the LLM to unzip everything).
    try:
        extract_epub(project.workspace / "source.epub", project.workspace / "original")
        # Reading order + titles are a mechanical OPF-spine parse; produce them
        # in code so the toc_verifier agent never has to hand-parse the OPF.
        generate_contents(project.workspace)
    except Exception:
        pass  # a malformed EPUB will surface via the disbinder's verification
    # The workspace is a git repository: that is the versioning mechanism.
    git = lambda *args: subprocess.run(["git", *args], cwd=project.workspace, check=True, capture_output=True)
    git("init", "-q")
    git("config", "user.email", "lexis@localhost")
    git("config", "user.name", "lexis")
    git("add", "-A")
    git("commit", "-qm", "lexis: project created")
    project.save()
    _projects[project_id] = project
    return project


PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
_load_from_disk()
