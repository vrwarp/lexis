"""HTTP/WebSocket server — port of claude/src/server.ts (same endpoints, same
event protocol, same web UI)."""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import HARNESS_DIR
from .epub import cover_mime, replace_cover
from .orchestrator import peek_session, session_for
from .projects import Project, create_project, get_project, list_projects
from .versioning import list_versions, revert_to_version, save_version

PORT = int(os.environ.get("PORT", "4701"))

app = FastAPI(title="lexis (smolagents)")

TEXT_EXTENSIONS = {
    ".xhtml", ".html", ".htm", ".txt", ".md", ".json", ".css", ".opf", ".ncx", ".xml", ".svg",
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}


def require_project(project_id: str) -> Project:
    project = get_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


def resolve_workspace_path(project: Project, rel: str) -> Path | None:
    """Resolve a user-supplied relative path safely inside the workspace."""
    abs_path = (project.workspace / rel).resolve()
    root = project.workspace.resolve()
    if abs_path != root and root not in abs_path.parents:
        return None
    if abs_path != root and ".git" in abs_path.relative_to(root).parts:
        return None
    return abs_path


# ---------- projects ----------


@app.get("/api/projects")
def api_list_projects():
    return [p.meta for p in list_projects()]


@app.post("/api/projects")
async def api_create_project(
    epub: UploadFile = File(...),
    name: str = Form(""),
    targetLanguage: str = Form(...),
    context: str = Form(""),
):
    if not (epub.filename or "").lower().endswith(".epub"):
        raise HTTPException(status_code=400, detail="an .epub file is required")
    if not targetLanguage.strip():
        raise HTTPException(status_code=400, detail="targetLanguage is required")
    data = await epub.read()
    project = create_project(
        name=name.strip() or (epub.filename or "book").rsplit(".epub", 1)[0],
        target_language=targetLanguage.strip(),
        context=context.strip(),
        epub_bytes=data,
        epub_filename=epub.filename or "source.epub",
    )
    return project.meta


@app.get("/api/projects/{project_id}")
def api_get_project(project_id: str):
    project = require_project(project_id)
    session = peek_session(project)
    return {
        **project.meta,
        "versions": list_versions(project),
        "awaitingReview": session.awaiting_review if session else False,
    }


@app.get("/api/projects/{project_id}/events")
def api_get_events(project_id: str, after: int = 0):
    return require_project(project_id).read_events(after)


# ---------- orchestration ----------


@app.post("/api/projects/{project_id}/start")
def api_start(project_id: str):
    project = require_project(project_id)
    meta = project.meta
    message = (
        f"Begin the translation of source.epub into {meta['targetLanguage']}. "
        + (f"User context: {meta['context']}. " if meta.get("context") else "")
        + "Run the full pipeline from Preparation onward. If the workspace already contains partial "
        "pipeline output (original/, notes/, draft/, final/), assess what is already done and continue "
        "from there instead of redoing completed work."
    )
    session_for(project).send(message)
    return {"ok": True}


@app.post("/api/projects/{project_id}/message")
async def api_message(project_id: str, request: Request):
    project = require_project(project_id)
    body = await request.json()
    text = str(body.get("text", "")).strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    session_for(project).send(text)
    return {"ok": True}


@app.post("/api/projects/{project_id}/review")
async def api_review(project_id: str, request: Request):
    project = require_project(project_id)
    body = await request.json()
    decision = body.get("decision")
    if decision not in ("approve", "revise"):
        raise HTTPException(status_code=400, detail="decision must be 'approve' or 'revise'")
    session = peek_session(project)
    if not session or not session.resolve_review(decision, body.get("instructions")):
        raise HTTPException(status_code=409, detail="no review is pending")
    return {"ok": True}


@app.post("/api/projects/{project_id}/interrupt")
def api_interrupt(project_id: str):
    session = peek_session(require_project(project_id))
    if session:
        session.interrupt()
    return {"ok": True}


# ---------- versions ----------


@app.get("/api/projects/{project_id}/versions")
def api_versions(project_id: str):
    return list_versions(require_project(project_id))


@app.post("/api/projects/{project_id}/versions")
async def api_save_version(project_id: str, request: Request):
    project = require_project(project_id)
    body = await request.json()
    version = save_version(project, str(body.get("label", "manual snapshot")))
    return version or {"unchanged": True}


@app.post("/api/projects/{project_id}/versions/{version_id}/revert")
def api_revert(project_id: str, version_id: str):
    project = require_project(project_id)
    version = revert_to_version(project, version_id)
    # Keep the orchestrator's mental model in sync if a session is live.
    session = peek_session(project)
    if session and session.running:
        session.send(
            f"[The user reverted the workspace to version {version_id[:8]} via the UI. Re-read the "
            "workspace state (notes/, draft/, final/) before doing anything else, and adjust your plan "
            "to match what actually exists now.]"
        )
    return version


# ---------- assets (inspection & review) ----------


@app.get("/api/projects/{project_id}/files")
def api_files(project_id: str):
    project = require_project(project_id)
    root = project.workspace.resolve()
    files = []
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root)
        if ".git" in rel.parts or not path.is_file():
            continue
        ext = path.suffix.lower()
        stat = path.stat()
        files.append(
            {
                "path": str(rel),
                "size": stat.st_size,
                "mtime": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
                "kind": "image" if ext in IMAGE_EXTENSIONS else "text" if ext in TEXT_EXTENSIONS else "binary",
            }
        )
    return files


@app.get("/api/projects/{project_id}/files/content")
def api_file_content(project_id: str, path: str = ""):
    project = require_project(project_id)
    abs_path = resolve_workspace_path(project, path)
    if not abs_path or not abs_path.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    size = abs_path.stat().st_size
    cap = 2 * 1024 * 1024
    data = abs_path.open("rb").read(min(size, cap))
    if b"\x00" in data:
        raise HTTPException(status_code=415, detail="binary file — use the raw endpoint")
    return {"path": path, "content": data.decode("utf-8", errors="replace"), "truncated": size > cap, "size": size}


@app.get("/api/projects/{project_id}/files/raw")
def api_file_raw(project_id: str, path: str = ""):
    project = require_project(project_id)
    abs_path = resolve_workspace_path(project, path)
    if not abs_path or not abs_path.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    return FileResponse(abs_path)


@app.post("/api/projects/{project_id}/files/comment")
async def api_file_comment(project_id: str, request: Request):
    project = require_project(project_id)
    body = await request.json()
    file_path = body.get("path")
    comment = str(body.get("comment", "")).strip()
    excerpt = str(body.get("excerpt", "") or "").strip()
    if not file_path or not comment:
        raise HTTPException(status_code=400, detail="path and comment are required")
    if not resolve_workspace_path(project, file_path):
        raise HTTPException(status_code=400, detail="invalid path")
    quoted = ""
    if excerpt:
        quoted = "\n\nRegarding this passage:\n" + "\n".join(f"> {line}" for line in excerpt[:1500].splitlines())
    session_for(project).send(f"[User comment on asset `{file_path}`]{quoted}\n\n{comment}")
    return {"ok": True}


# ---------- cover & packaging ----------


@app.post("/api/projects/{project_id}/cover")
async def api_cover(project_id: str, cover: UploadFile = File(...)):
    project = require_project(project_id)
    if not cover.filename or not cover_mime(cover.filename):
        raise HTTPException(status_code=400, detail="a jpg/png/gif/webp/svg image is required")
    # Remove older overrides so the packager sees exactly one.
    for file in project.workspace.iterdir():
        if file.name.startswith("cover_override."):
            file.unlink()
    ext = Path(cover.filename).suffix.lower()
    dest = f"cover_override{ext}"
    (project.workspace / dest).write_bytes(await cover.read())
    project.meta["coverFilename"] = dest
    project.save()
    project.emit(
        "status", "user", {"status": project.meta["status"], "detail": f"Custom cover uploaded ({dest})"}
    )
    return {"ok": True, "coverFilename": dest}


@app.post("/api/projects/{project_id}/repackage")
def api_repackage(project_id: str):
    project = require_project(project_id)
    if not project.meta.get("outputPath") or not project.meta.get("coverFilename"):
        raise HTTPException(status_code=400, detail="requires a completed epub and an uploaded cover")
    replace_cover(
        project.workspace / project.meta["outputPath"],
        project.workspace / project.meta["coverFilename"],
    )
    save_version(project, "repackaged with custom cover")
    project.emit(
        "progress",
        "orchestrator",
        {
            "phase": "packaging",
            "state": "completed",
            "detail": "Repackaged with custom cover (deterministic, no agent involved)",
        },
    )
    return {"ok": True}


@app.get("/api/projects/{project_id}/download")
def api_download(project_id: str):
    project = require_project(project_id)
    if not project.meta.get("outputPath"):
        raise HTTPException(status_code=404, detail="no translated epub yet")
    return FileResponse(
        project.workspace / project.meta["outputPath"],
        filename=f"{project.meta['name']} ({project.meta['targetLanguage']}).epub",
        media_type="application/epub+zip",
    )


# ---------- websocket ----------


@app.websocket("/ws")
async def ws_events(websocket: WebSocket):
    await websocket.accept()
    project = get_project(websocket.query_params.get("project") or "")
    if project is None:
        await websocket.close(code=4004, reason="unknown project")
        return
    after = int(websocket.query_params.get("after") or 0)
    for event in project.read_events(after):
        await websocket.send_json(event)
    loop = asyncio.get_running_loop()
    q: asyncio.Queue = asyncio.Queue()
    unsubscribe = project.subscribe(lambda event: loop.call_soon_threadsafe(q.put_nowait, event))
    try:
        while True:
            sender = asyncio.create_task(q.get())
            receiver = asyncio.create_task(websocket.receive_text())  # detect disconnects
            done, pending = await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            if receiver in done:
                receiver.result()  # raises WebSocketDisconnect when closed
            if sender in done:
                await websocket.send_json(sender.result())
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        unsubscribe()


# ---------- static UI ----------

app.mount("/", StaticFiles(directory=HARNESS_DIR / "public", html=True), name="static")


def main() -> None:
    import uvicorn

    for var in ("OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "HF_TOKEN"):
        if os.environ.get(var):
            break
    else:
        print(
            "note: no provider API key detected in the environment "
            "(OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / HF_TOKEN / …). "
            "The default models.json uses OpenRouter free models — set OPENROUTER_API_KEY "
            "(https://openrouter.ai/keys), or configure whichever provider your tiers reference."
        )
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
