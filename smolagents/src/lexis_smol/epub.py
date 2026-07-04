"""Deterministic EPUB cover replacement — port of claude/src/epub.ts.

The no-tokens repackage path used when the user supplies a custom cover after
the translated EPUB has already been produced. Pure zipfile — no zip/unzip
binaries needed — but preserves the OCF rules: `mimetype` first, stored
uncompressed.
"""

from __future__ import annotations

import re
import shutil
import tempfile
import urllib.parse
import zipfile
from pathlib import Path

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
