"""Workspace-rooted file tools — the port of the Agent SDK's Read/Write/Edit/
Glob/Grep/Bash toolset, which smolagents does not ship.

Every path is resolved inside the project workspace (path jail, `.git`
excluded); outputs are size-capped so a single observation cannot flood a
model's context. Tool contracts mirror the SDK equivalents so the agent
prompts written for the Claude harness behave identically here.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from smolagents import Tool

MAX_READ_LINES = 2000
MAX_LINE_CHARS = 2000
MAX_OBSERVATION_CHARS = 200_000
MAX_BASH_CHARS = 30_000
MAX_GREP_MATCHES = 200


class WorkspaceError(Exception):
    pass


def _jail(workspace: Path, rel: str) -> Path:
    """Resolve a user/model-supplied path safely inside the workspace."""
    abs_path = (workspace / rel).resolve()
    root = workspace.resolve()
    if abs_path != root and root not in abs_path.parents:
        raise WorkspaceError(f"Path escapes the workspace: {rel}")
    if ".git" in abs_path.relative_to(root).parts:
        raise WorkspaceError("The .git directory is managed by the harness and is off-limits.")
    return abs_path


def _cap(text: str, limit: int = MAX_OBSERVATION_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… (output truncated at {limit} characters)"


class ReadFileTool(Tool):
    name = "read_file"
    description = (
        "Read a text file from the workspace. Returns line-numbered content. "
        f"Reads up to {MAX_READ_LINES} lines from `offset`; for longer files call again with a larger offset."
    )
    inputs = {
        "path": {"type": "string", "description": "File path relative to the project root"},
        "offset": {"type": "integer", "description": "1-based line number to start from (default 1)", "nullable": True},
        "limit": {"type": "integer", "description": f"Maximum lines to read (default {MAX_READ_LINES})", "nullable": True},
    }
    output_type = "string"

    def __init__(self, workspace: Path):
        super().__init__()
        self.workspace = workspace

    def forward(self, path: str, offset: int | None = None, limit: int | None = None) -> str:
        file = _jail(self.workspace, path)
        if not file.is_file():
            return f"Error: file not found: {path}"
        start = max(1, offset or 1)
        count = min(limit or MAX_READ_LINES, MAX_READ_LINES)
        lines = file.read_text(encoding="utf-8", errors="replace").splitlines()
        window = lines[start - 1 : start - 1 + count]
        numbered = []
        for i, line in enumerate(window, start=start):
            if len(line) > MAX_LINE_CHARS:
                line = line[:MAX_LINE_CHARS] + " … (line truncated)"
            numbered.append(f"{i}\t{line}")
        body = "\n".join(numbered)
        if start - 1 + count < len(lines):
            body += f"\n… (file has {len(lines)} lines; continue with offset={start + count})"
        return _cap(body or "(empty file)")


class WriteFileTool(Tool):
    name = "write_file"
    description = (
        "Write a text file in the workspace, creating parent directories and overwriting any existing file. "
        "The content is written exactly as given."
    )
    inputs = {
        "path": {"type": "string", "description": "File path relative to the project root"},
        "content": {"type": "string", "description": "Full file content to write"},
    }
    output_type = "string"

    def __init__(self, workspace: Path):
        super().__init__()
        self.workspace = workspace

    def forward(self, path: str, content: str) -> str:
        file = _jail(self.workspace, path)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content, encoding="utf-8")
        return f"Wrote {len(content)} characters to {path}"


class EditFileTool(Tool):
    name = "edit_file"
    description = (
        "Replace an exact string in a file. `old_string` must match the file contents exactly and be unique "
        "unless `replace_all` is true. Prefer this over write_file for targeted fixes in large files."
    )
    inputs = {
        "path": {"type": "string", "description": "File path relative to the project root"},
        "old_string": {"type": "string", "description": "Exact text to replace (must be unique unless replace_all)"},
        "new_string": {"type": "string", "description": "Replacement text"},
        "replace_all": {"type": "boolean", "description": "Replace every occurrence (default false)", "nullable": True},
    }
    output_type = "string"

    def __init__(self, workspace: Path):
        super().__init__()
        self.workspace = workspace

    def forward(self, path: str, old_string: str, new_string: str, replace_all: bool | None = None) -> str:
        file = _jail(self.workspace, path)
        if not file.is_file():
            return f"Error: file not found: {path}"
        text = file.read_text(encoding="utf-8", errors="replace")
        occurrences = text.count(old_string)
        if occurrences == 0:
            return "Error: old_string not found in the file. Read the file and retry with the exact text."
        if occurrences > 1 and not replace_all:
            return (
                f"Error: old_string occurs {occurrences} times; provide more surrounding context to make it "
                "unique, or set replace_all=true."
            )
        file.write_text(text.replace(old_string, new_string), encoding="utf-8")
        return f"Replaced {occurrences if replace_all else 1} occurrence(s) in {path}"


class GlobTool(Tool):
    name = "glob"
    description = 'Find files matching a glob pattern (e.g. "original/**/*.xhtml"). Returns sorted relative paths.'
    inputs = {
        "pattern": {"type": "string", "description": "Glob pattern relative to the project root"},
        "path": {"type": "string", "description": "Subdirectory to search in (default project root)", "nullable": True},
    }
    output_type = "string"

    def __init__(self, workspace: Path):
        super().__init__()
        self.workspace = workspace

    def forward(self, pattern: str, path: str | None = None) -> str:
        base = _jail(self.workspace, path or ".")
        root = self.workspace.resolve()
        matches = sorted(
            str(p.relative_to(root))
            for p in base.glob(pattern)
            if p.is_file() and ".git" not in p.relative_to(root).parts
        )
        if not matches:
            return "No files matched."
        return _cap("\n".join(matches))


class GrepTool(Tool):
    name = "grep"
    description = (
        "Search file contents with a Python regular expression. Returns `path:line: text` matches "
        f"(capped at {MAX_GREP_MATCHES}). Useful for locating text and for script-mismatch scans "
        r"(e.g. pattern [A-Za-z]{3,} to find Latin-script strays, or [一-鿿] for Han characters)."
    )
    inputs = {
        "pattern": {"type": "string", "description": "Python regular expression, searched per line"},
        "path": {"type": "string", "description": "File or directory to search (default project root)", "nullable": True},
        "glob": {"type": "string", "description": 'Only search files matching this glob (e.g. "*.xhtml")', "nullable": True},
        "max_matches": {"type": "integer", "description": f"Cap on reported matches (default {MAX_GREP_MATCHES})", "nullable": True},
    }
    output_type = "string"

    def __init__(self, workspace: Path):
        super().__init__()
        self.workspace = workspace

    def forward(
        self, pattern: str, path: str | None = None, glob: str | None = None, max_matches: int | None = None
    ) -> str:
        try:
            regex = re.compile(pattern)
        except re.error as e:
            return f"Error: invalid regular expression: {e}"
        target = _jail(self.workspace, path or ".")
        root = self.workspace.resolve()
        cap = min(max_matches or MAX_GREP_MATCHES, MAX_GREP_MATCHES)
        if target.is_file():
            files = [target]
        else:
            files = sorted(
                p
                for p in target.rglob(glob or "*")
                if p.is_file() and ".git" not in p.relative_to(root).parts
            )
        out: list[str] = []
        for file in files:
            try:
                text = file.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for lineno, line in enumerate(text.splitlines(), start=1):
                if regex.search(line):
                    snippet = line.strip()
                    if len(snippet) > 400:
                        snippet = snippet[:400] + " …"
                    out.append(f"{file.relative_to(root)}:{lineno}: {snippet}")
                    if len(out) >= cap:
                        out.append(f"… (stopped at {cap} matches)")
                        return _cap("\n".join(out))
        return _cap("\n".join(out)) if out else "No matches found."


class BashTool(Tool):
    name = "bash"
    description = (
        "Run a shell command with the project root as the working directory. Use for EPUB zip/unzip work "
        "and quick checks (ls, wc, file). Returns stdout+stderr and the exit code."
    )
    inputs = {
        "command": {"type": "string", "description": "The shell command to execute"},
        "timeout": {"type": "integer", "description": "Timeout in seconds (default 120, max 600)", "nullable": True},
    }
    output_type = "string"

    def __init__(self, workspace: Path):
        super().__init__()
        self.workspace = workspace

    def forward(self, command: str, timeout: int | None = None) -> str:
        try:
            result = subprocess.run(
                ["bash", "-lc", command],
                cwd=self.workspace,
                capture_output=True,
                text=True,
                timeout=min(timeout or 120, 600),
            )
        except subprocess.TimeoutExpired:
            return "Error: command timed out."
        output = (result.stdout or "") + (("\n" + result.stderr) if result.stderr else "")
        output = output.strip() or "(no output)"
        if len(output) > MAX_BASH_CHARS:
            output = output[:MAX_BASH_CHARS] + f"\n… (output truncated at {MAX_BASH_CHARS} characters)"
        return f"exit code: {result.returncode}\n{output}"


TOOL_CLASSES = {
    "read_file": ReadFileTool,
    "write_file": WriteFileTool,
    "edit_file": EditFileTool,
    "glob": GlobTool,
    "grep": GrepTool,
    "bash": BashTool,
}


def build_toolset(workspace: Path | str, names: list[str]) -> list[Tool]:
    workspace = Path(workspace)  # accept str or Path so `ws / rel` never fails
    unknown = [n for n in names if n not in TOOL_CLASSES]
    if unknown:
        raise ValueError(f"Unknown tool(s) in agent definition: {unknown}")
    return [TOOL_CLASSES[n](workspace) for n in names]
