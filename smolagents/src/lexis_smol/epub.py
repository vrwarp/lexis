"""Deterministic EPUB cover replacement — port of claude/src/epub.ts.

The no-tokens repackage path used when the user supplies a custom cover after
the translated EPUB has already been produced. Pure zipfile — no zip/unzip
binaries needed — but preserves the OCF rules: `mimetype` first, stored
uncompressed.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import urllib.parse
import zipfile
from pathlib import Path

CONTENT_MEDIA_TYPES = ("application/xhtml+xml", "text/html")

IMAGE_MIME = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}


def cover_mime(filename: str) -> str | None:
    return IMAGE_MIME.get(Path(filename).suffix.lower())


def extract_epub(epub_path: Path, dest: Path) -> int:
    """Deterministically and completely extract an EPUB into `dest`.

    Extraction is a purely mechanical operation; doing it in code (rather than
    trusting an LLM agent to run `unzip`) guarantees every content file — the
    OPF, the spine, images, all of it — actually lands on disk. See
    docs/LESSONS.md #4: mechanical integrity must not depend on LLM judgment.
    Returns the number of files written.
    """
    epub_path, dest = Path(epub_path), Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    with zipfile.ZipFile(epub_path) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            target = (dest / info.filename).resolve()
            if target != root and root not in target.parents:
                raise ValueError(f"EPUB entry escapes the destination: {info.filename}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
    return sum(1 for p in dest.rglob("*") if p.is_file())


def _opf_path(original: Path) -> Path | None:
    """Locate the OPF package document via META-INF/container.xml."""
    container = original / "META-INF" / "container.xml"
    if not container.exists():
        return None
    m = re.search(r'full-path="([^"]+)"', container.read_text(encoding="utf-8", errors="replace"))
    if not m:
        return None
    opf = (original / urllib.parse.unquote(m.group(1))).resolve()
    return opf if opf.exists() else None


def _titles_from_nav(opf: str, opf_dir: Path, manifest: dict[str, tuple[str, str]]) -> dict[str, str]:
    """Map content-file basename -> chapter title, from the NCX or nav document."""
    titles: dict[str, str] = {}
    # EPUB2 NCX: <navPoint><navLabel><text>Title</text></navLabel><content src="href"/>
    ncx_href = next((h for h, mt in manifest.values() if mt == "application/x-dtbncx+xml"), None)
    if not ncx_href:
        ncx_href = next((h for h, _ in manifest.values() if h.lower().endswith(".ncx")), None)
    if ncx_href:
        ncx_file = (opf_dir / ncx_href).resolve()
        if ncx_file.exists():
            ncx = ncx_file.read_text(encoding="utf-8", errors="replace")
            for point in re.findall(r"<navPoint\b.*?</navPoint>", ncx, re.S):
                label = re.search(r"<text\b[^>]*>(.*?)</text>", point, re.S)
                src = re.search(r'<content\b[^>]*src="([^"#]+)', point)
                if label and src:
                    titles.setdefault(os.path.basename(urllib.parse.unquote(src.group(1))), _clean(label.group(1)))
    # EPUB3 nav document: <a href="href">Title</a> inside the toc nav.
    nav_href = next((h for h, mt in manifest.values() if mt in CONTENT_MEDIA_TYPES and "nav" in h.lower()), None)
    if nav_href:
        nav_file = (opf_dir / nav_href).resolve()
        if nav_file.exists():
            nav = nav_file.read_text(encoding="utf-8", errors="replace")
            for href, text in re.findall(r'<a\b[^>]*href="([^"#]+)[^"]*"[^>]*>(.*?)</a>', nav, re.S):
                titles.setdefault(os.path.basename(urllib.parse.unquote(href)), _clean(text))
    return titles


def _file_title(path: Path) -> str | None:
    """Fallback title from a content file's <title> or first heading."""
    if not path.exists():
        return None
    head = path.read_text(encoding="utf-8", errors="replace")[:4000]
    for pattern in (r"<title\b[^>]*>(.*?)</title>", r"<h1\b[^>]*>(.*?)</h1>", r"<h2\b[^>]*>(.*?)</h2>"):
        m = re.search(pattern, head, re.S | re.I)
        if m:
            title = _clean(m.group(1))
            if title:
                return title
    return None


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", text)).strip()


def generate_contents(workspace: Path) -> int:
    """Write a BASELINE notes/contents.json (reading order + titles) from the OPF
    spine. Parsing the spine is a mechanical task the LLM toc_generator does
    unreliably by hand, so we do it in code (docs/LESSONS.md #4). This is only a
    baseline, though: it is only as good as the book's own OPF annotation, so the
    toc_generator agent still verifies it against the actual files and may
    override it for poorly-annotated books. Returns the number of chapters
    written, or 0 if there is no usable OPF (the agent builds it from scratch)."""
    workspace = Path(workspace)
    original = workspace / "original"
    opf_file = _opf_path(original)
    if opf_file is None:
        return 0
    opf = opf_file.read_text(encoding="utf-8", errors="replace")
    opf_dir = opf_file.parent

    manifest: dict[str, tuple[str, str]] = {}
    for tag in re.findall(r"<item\b[^>]*>", opf):
        tid, href = _attr(tag, "id"), _attr(tag, "href")
        if tid and href:
            manifest[tid] = (urllib.parse.unquote(href), _attr(tag, "media-type") or "")

    spine_match = re.search(r"<spine\b[^>]*>(.*?)</spine>", opf, re.S)
    if not spine_match:
        return 0
    ordered_hrefs: list[str] = []
    for tag in re.findall(r"<itemref\b[^>]*>", spine_match.group(1)):
        if _attr(tag, "linear") == "no":
            continue
        idref = _attr(tag, "idref")
        if not idref or idref not in manifest:
            continue
        href, media = manifest[idref]
        if media and media not in CONTENT_MEDIA_TYPES:
            continue
        ordered_hrefs.append(href)
    if not ordered_hrefs:
        return 0

    titles = _titles_from_nav(opf, opf_dir, manifest)
    root = original.resolve()
    contents = []
    for index, href in enumerate(ordered_hrefs, start=1):
        abs_path = (opf_dir / href).resolve()
        try:
            filename = abs_path.relative_to(root).as_posix()
        except ValueError:
            filename = os.path.basename(href)
        base = os.path.basename(href)
        title = titles.get(base) or _file_title(abs_path) or os.path.splitext(base)[0]
        contents.append({"index": index, "filename": filename, "title": title})

    notes = workspace / "notes"
    notes.mkdir(parents=True, exist_ok=True)
    (notes / "contents.json").write_text(json.dumps(contents, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(contents)


def _attr(tag: str, name: str) -> str | None:
    m = re.search(rf'{name}="([^"]*)"', tag)
    return m.group(1) if m else None


def replace_cover(epub_path: Path, cover_path: Path) -> None:
    mime = cover_mime(str(cover_path))
    if not mime:
        raise ValueError(f"Unsupported cover image type: {cover_path.name}")

    tmp = Path(tempfile.mkdtemp(prefix="lexis-repack-"))
    try:
        with zipfile.ZipFile(epub_path) as zf:
            zf.extractall(tmp)

        # 1. container.xml -> OPF path
        container = (tmp / "META-INF" / "container.xml").read_text(encoding="utf-8")
        m = re.search(r'full-path="([^"]+)"', container)
        if not m:
            raise ValueError("Could not locate the OPF package document")
        opf_path = tmp / m.group(1)
        opf = opf_path.read_text(encoding="utf-8")

        # 2. Find the cover manifest item: properties="cover-image" first, then
        #    the EPUB2 <meta name="cover" content="id"> convention.
        items = re.findall(r"<item\b[^>]*>", opf)
        cover_item = next(
            (tag for tag in items if re.search(r'properties="[^"]*\bcover-image\b[^"]*"', tag)), None
        )
        if cover_item is None:
            cover_id = None
            m = re.search(r'<meta\b[^>]*name="cover"[^>]*content="([^"]+)"', opf) or re.search(
                r'<meta\b[^>]*content="([^"]+)"[^>]*name="cover"', opf
            )
            if m:
                cover_id = m.group(1)
            if cover_id:
                cover_item = next((tag for tag in items if _attr(tag, "id") == cover_id), None)
        if cover_item is None:
            # Last resort: an image whose name mentions "cover".
            cover_item = next(
                (
                    tag
                    for tag in items
                    if (_attr(tag, "media-type") or "").startswith("image/")
                    and re.search(r"cover", _attr(tag, "href") or "", re.I)
                ),
                None,
            )
        if cover_item is None:
            raise ValueError("Could not identify a cover image in the EPUB manifest")
        href = _attr(cover_item, "href")
        if not href:
            raise ValueError("Cover manifest item has no href")

        # 3. Overwrite the image bytes; fix the declared media-type if it changed.
        image_path = (opf_path.parent / urllib.parse.unquote(href)).resolve()
        if not str(image_path).startswith(str(tmp.resolve())):
            raise ValueError("Cover path escapes the EPUB")
        shutil.copyfile(cover_path, image_path)
        old_mime = _attr(cover_item, "media-type")
        if old_mime and old_mime != mime:
            opf = opf.replace(cover_item, cover_item.replace(f'media-type="{old_mime}"', f'media-type="{mime}"'))
            opf_path.write_text(opf, encoding="utf-8")

        # 4. Re-zip: mimetype first and stored, everything else deflated.
        out = epub_path.with_suffix(epub_path.suffix + ".tmp")
        out.unlink(missing_ok=True)
        with zipfile.ZipFile(out, "w") as zf:
            mimetype = tmp / "mimetype"
            if mimetype.exists():
                zf.write(mimetype, "mimetype", compress_type=zipfile.ZIP_STORED)
            for file in sorted(tmp.rglob("*")):
                if file.is_dir() or file == mimetype:
                    continue
                zf.write(file, file.relative_to(tmp).as_posix(), compress_type=zipfile.ZIP_DEFLATED)
        out.replace(epub_path)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
