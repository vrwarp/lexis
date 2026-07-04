import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export function coverMime(filename: string): string | undefined {
  return IMAGE_MIME[path.extname(filename).toLowerCase()];
}

/**
 * Deterministically and completely extract an EPUB into `dest`.
 *
 * Extraction is a purely mechanical operation; doing it in code (rather than
 * trusting an LLM agent to run `unzip`) guarantees every content file — the
 * OPF, the spine, images, all of it — actually lands on disk. See
 * docs/LESSONS.md #4: mechanical integrity must not depend on LLM judgment.
 * Returns the number of files written.
 */
export async function extractEpub(epubPath: string, dest: string): Promise<number> {
  fs.mkdirSync(dest, { recursive: true });
  // `unzip -o` extracts the entire archive at once, overwriting — complete and idempotent.
  await execFileAsync('unzip', ['-o', '-qq', epubPath, '-d', dest]);
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else count += 1;
    }
  };
  walk(dest);
  return count;
}

const CONTENT_MEDIA_TYPES = new Set(['application/xhtml+xml', 'text/html']);

/** Raised by validateEpub when an extracted EPUB cannot be translated. */
export class EpubError extends Error {}

/**
 * Deterministic sanity checks on the freshly-extracted EPUB. Throws EpubError on
 * a fatal problem (DRM, or no reachable package document); returns a list of
 * non-fatal warnings.
 *
 * This is the in-code replacement for the LLM ebook_disbinder's "verification":
 * extractEpub already guarantees every archive entry is on disk, and structural
 * validity is a purely mechanical check that must not depend on a model
 * (docs/LESSONS.md #4). Doing it here is certain, free, and cannot spin.
 */
export function validateEpub(workspace: string): string[] {
  const original = path.join(workspace, 'original');
  if (fs.existsSync(path.join(original, 'META-INF', 'encryption.xml'))) {
    throw new EpubError(
      'The EPUB appears to be DRM-protected (META-INF/encryption.xml is present); its content is encrypted and cannot be translated.',
    );
  }
  if (!opfPath(original)) {
    throw new EpubError(
      'This does not look like a valid EPUB: no package document (.opf) is reachable from META-INF/container.xml.',
    );
  }
  const warnings: string[] = [];
  const mimetype = path.join(original, 'mimetype');
  if (!fs.existsSync(mimetype)) {
    warnings.push('mimetype file is missing');
  } else if (fs.readFileSync(mimetype, 'utf8').trim() !== 'application/epub+zip') {
    warnings.push("mimetype is not 'application/epub+zip'");
  }
  return warnings;
}

function attrOf(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function clean(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function opfPath(original: string): string | null {
  const container = path.join(original, 'META-INF', 'container.xml');
  if (!fs.existsSync(container)) return null;
  const full = fs.readFileSync(container, 'utf8').match(/full-path="([^"]+)"/)?.[1];
  if (!full) return null;
  const opf = path.resolve(original, decodeURIComponent(full));
  return fs.existsSync(opf) ? opf : null;
}

function titlesFromNav(opfDir: string, manifest: Map<string, { href: string; media: string }>): Map<string, string> {
  const titles = new Map<string, string>();
  const setBase = (href: string, title: string) => {
    const base = path.basename(decodeURIComponent(href));
    if (!titles.has(base) && title) titles.set(base, title);
  };
  // EPUB2 NCX.
  let ncxHref = [...manifest.values()].find((m) => m.media === 'application/x-dtbncx+xml')?.href;
  if (!ncxHref) ncxHref = [...manifest.values()].find((m) => m.href.toLowerCase().endsWith('.ncx'))?.href;
  if (ncxHref) {
    const ncxFile = path.resolve(opfDir, ncxHref);
    if (fs.existsSync(ncxFile)) {
      const ncx = fs.readFileSync(ncxFile, 'utf8');
      for (const point of ncx.match(/<navPoint\b[\s\S]*?<\/navPoint>/g) ?? []) {
        const label = point.match(/<text\b[^>]*>([\s\S]*?)<\/text>/)?.[1];
        const src = point.match(/<content\b[^>]*src="([^"#]+)/)?.[1];
        if (label && src) setBase(src, clean(label));
      }
    }
  }
  // EPUB3 nav document.
  const navHref = [...manifest.values()].find((m) => CONTENT_MEDIA_TYPES.has(m.media) && /nav/i.test(m.href))?.href;
  if (navHref) {
    const navFile = path.resolve(opfDir, navHref);
    if (fs.existsSync(navFile)) {
      const nav = fs.readFileSync(navFile, 'utf8');
      for (const m of nav.matchAll(/<a\b[^>]*href="([^"#]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
        setBase(m[1], clean(m[2]));
      }
    }
  }
  return titles;
}

function fileTitle(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const head = fs.readFileSync(filePath, 'utf8').slice(0, 4000);
  for (const re of [/<title\b[^>]*>([\s\S]*?)<\/title>/i, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i, /<h2\b[^>]*>([\s\S]*?)<\/h2>/i]) {
    const t = head.match(re)?.[1];
    if (t && clean(t)) return clean(t);
  }
  return undefined;
}

/**
 * Write a BASELINE `notes/contents.json` (reading order + titles) from the OPF
 * spine. Parsing the spine is a mechanical task the LLM toc_verifier does
 * unreliably by hand, so we do it in code (docs/LESSONS.md #4). This is only a
 * baseline, though: it is only as good as the book's own OPF annotation, so the
 * toc_verifier agent still verifies it against the actual files and may override
 * it for poorly-annotated books. Returns the number of chapters, or 0 if there is
 * no usable OPF (the agent then builds it from scratch).
 */
export function generateContents(workspace: string): number {
  const original = path.join(workspace, 'original');
  const opf = opfPath(original);
  if (!opf) return 0;
  const opfText = fs.readFileSync(opf, 'utf8');
  const opfDir = path.dirname(opf);

  const manifest = new Map<string, { href: string; media: string }>();
  for (const tag of opfText.match(/<item\b[^>]*>/g) ?? []) {
    const id = attrOf(tag, 'id');
    const href = attrOf(tag, 'href');
    if (id && href) manifest.set(id, { href: decodeURIComponent(href), media: attrOf(tag, 'media-type') ?? '' });
  }

  const spine = opfText.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/)?.[1];
  if (!spine) return 0;
  const orderedHrefs: string[] = [];
  for (const tag of spine.match(/<itemref\b[^>]*>/g) ?? []) {
    if (attrOf(tag, 'linear') === 'no') continue;
    const idref = attrOf(tag, 'idref');
    const item = idref ? manifest.get(idref) : undefined;
    if (!item) continue;
    if (item.media && !CONTENT_MEDIA_TYPES.has(item.media)) continue;
    orderedHrefs.push(item.href);
  }
  if (orderedHrefs.length === 0) return 0;

  const titles = titlesFromNav(opfDir, manifest);
  const root = path.resolve(original);
  const contents = orderedHrefs.map((href, i) => {
    const abs = path.resolve(opfDir, href);
    const rel = abs.startsWith(root + path.sep) ? path.relative(root, abs).split(path.sep).join('/') : path.basename(href);
    const base = path.basename(href);
    const title = titles.get(base) ?? fileTitle(abs) ?? base.replace(/\.[^.]+$/, '');
    return { index: i + 1, filename: rel, title };
  });

  const notes = path.join(workspace, 'notes');
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'contents.json'), JSON.stringify(contents, null, 2), 'utf8');
  return contents.length;
}

/**
 * Deterministically replace the cover image inside a built EPUB and re-zip it
 * (mimetype entry first, stored uncompressed, per the OCF spec).
 *
 * This is the no-tokens repackage path used when the user supplies a custom
 * cover after the translated EPUB has already been produced. It keeps the
 * original cover entry's filename and updates the OPF media-type when the
 * image format differs.
 */
export async function replaceCover(epubPath: string, coverPath: string): Promise<void> {
  const mime = coverMime(coverPath);
  if (!mime) throw new Error(`Unsupported cover image type: ${path.basename(coverPath)}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-repack-'));
  try {
    await execFileAsync('unzip', ['-qq', epubPath, '-d', tmp]);

    // 1. container.xml -> OPF path
    const container = fs.readFileSync(path.join(tmp, 'META-INF', 'container.xml'), 'utf8');
    const opfRel = container.match(/full-path="([^"]+)"/)?.[1];
    if (!opfRel) throw new Error('Could not locate the OPF package document');
    const opfPath = path.join(tmp, opfRel);
    let opf = fs.readFileSync(opfPath, 'utf8');

    // 2. Find the cover manifest item: properties="cover-image" first, then
    //    the EPUB2 <meta name="cover" content="id"> convention.
    const items = [...opf.matchAll(/<item\b[^>]*>/g)].map((m) => m[0]);
    const attr = (tag: string, name: string) =>
      tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
    let coverItem = items.find((tag) => /properties="[^"]*\bcover-image\b[^"]*"/.test(tag));
    if (!coverItem) {
      const coverId = opf.match(/<meta\b[^>]*name="cover"[^>]*content="([^"]+)"/)?.[1]
        ?? opf.match(/<meta\b[^>]*content="([^"]+)"[^>]*name="cover"/)?.[1];
      if (coverId) coverItem = items.find((tag) => attr(tag, 'id') === coverId);
    }
    if (!coverItem) {
      // Last resort: an image whose name mentions "cover".
      coverItem = items.find(
        (tag) => attr(tag, 'media-type')?.startsWith('image/') && /cover/i.test(attr(tag, 'href') ?? ''),
      );
    }
    if (!coverItem) throw new Error('Could not identify a cover image in the EPUB manifest');
    const href = attr(coverItem, 'href');
    if (!href) throw new Error('Cover manifest item has no href');

    // 3. Overwrite the image bytes; fix the declared media-type if it changed.
    const imagePath = path.join(path.dirname(opfPath), decodeURIComponent(href));
    if (!imagePath.startsWith(tmp)) throw new Error('Cover path escapes the EPUB');
    fs.copyFileSync(coverPath, imagePath);
    const oldMime = attr(coverItem, 'media-type');
    if (oldMime && oldMime !== mime) {
      opf = opf.replace(coverItem, coverItem.replace(`media-type="${oldMime}"`, `media-type="${mime}"`));
      fs.writeFileSync(opfPath, opf);
    }

    // 4. Re-zip: mimetype first and stored, everything else deflated.
    const out = epubPath + '.tmp';
    fs.rmSync(out, { force: true });
    if (fs.existsSync(path.join(tmp, 'mimetype'))) {
      await execFileAsync('zip', ['-0Xq', out, 'mimetype'], { cwd: tmp });
      await execFileAsync('zip', ['-rgq', out, '.', '-x', 'mimetype'], { cwd: tmp });
    } else {
      await execFileAsync('zip', ['-rXq', out, '.'], { cwd: tmp });
    }
    fs.renameSync(out, epubPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
