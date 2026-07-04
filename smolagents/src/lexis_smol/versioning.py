"""Workspace versioning on git — port of claude/src/versioning.ts."""

from __future__ import annotations

import subprocess
from typing import Any

from .projects import Project

AUTO_PREFIX = "auto: "


def _git(project: Project, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=project.workspace, check=True, capture_output=True, text=True
    )
    return result.stdout.strip()


def save_version(project: Project, label: str, auto: bool = False) -> dict[str, Any] | None:
    """Snapshot the whole workspace as a git commit. Returns None when nothing changed."""
    _git(project, "add", "-A")
    if not _git(project, "status", "--porcelain"):
        return None
    _git(project, "commit", "-qm", (AUTO_PREFIX if auto else "") + label)
    version = list_versions(project)[0]
    project.emit("version", "orchestrator", {"version": version})
    return version


def list_versions(project: Project) -> list[dict[str, Any]]:
    raw = _git(project, "log", "--format=%H%x1f%s%x1f%cI")
    versions = []
    for line in raw.splitlines():
        commit_id, subject, date = line.split("\x1f")
        auto = subject.startswith(AUTO_PREFIX)
        versions.append(
            {
                "id": commit_id,
                "label": subject[len(AUTO_PREFIX):] if auto else subject,
                "date": date,
                "auto": auto,
            }
        )
    return versions


def revert_to_version(project: Project, version_id: str) -> dict[str, Any]:
    """Restore the workspace to a previous version, non-destructively:
    current state is snapshotted first and the revert itself is a new version."""
    versions = list_versions(project)
    target = next((v for v in versions if v["id"] == version_id or v["id"].startswith(version_id)), None)
    if target is None:
        raise ValueError(f"Unknown version: {version_id}")
    save_version(project, "snapshot before revert", auto=True)
    # Make the working tree exactly match the target commit (checkout -- . alone
    # would leave behind files added after the target).
    _git(project, "rm", "-rq", "--ignore-unmatch", ".")
    _git(project, "checkout", target["id"], "--", ".")
    version = save_version(project, f"revert to {target['id'][:8]} ({target['label']})")
    return version or target
