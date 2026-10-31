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

// ---------- reading an EPUB's structure ----------

/** The attributes of one XML tag, lower-cased names, entities left alone. */
export function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[e as string] ?? '');
}

/** The visible text of an (X)HTML document: scripts, styles and tags removed, whitespace collapsed. */
export function textOf(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<head\b[\s\S]*?<\/head>/i, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words for Latin-script text, characters for CJK, so the count means something either way. */
export function countWords(text: string): number {
  const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length;
  const words = (text.replace(/[぀-ヿ㐀-鿿가-힯]/g, ' ').match(/[^\s]+/g) ?? []).length;
  return cjk + words;
}

export interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string[];
}

export interface Package {
  /** The OPF's path relative to the EPUB root, e.g. OEBPS/content.opf. */
  opfPath: string;
  /** The directory hrefs resolve against, relative to the EPUB root ('' at the root). */
  opfDir: string;
  manifest: ManifestItem[];
  spine: { idref: string; linear: boolean }[];
  title?: string;
  language?: string;
}

/** Parse META-INF/container.xml and the OPF it points to. Throws when the layout is not an EPUB. */
export function readPackage(root: string): Package {
  const containerPath = path.join(root, 'META-INF', 'container.xml');
  if (!fs.existsSync(containerPath)) throw new Error('not an EPUB: META-INF/container.xml is missing');
  const container = fs.readFileSync(containerPath, 'utf8');
  const rootfile = [...container.matchAll(/<rootfile\b[^>]*>/g)].map((m) => attrs(m[0])).find((a) => a['full-path']);
  if (!rootfile) throw new Error('not an EPUB: container.xml names no package document');
  const opfPath = rootfile['full-path'];
  const opfAbs = path.join(root, opfPath);
  if (!fs.existsSync(opfAbs)) throw new Error(`not an EPUB: package document ${opfPath} is missing`);
  const opf = fs.readFileSync(opfAbs, 'utf8');
  const manifest = [...opf.matchAll(/<(?:opf:)?item\b[^>]*>/g)].map((m) => {
    const a = attrs(m[0]);
    return { id: a.id ?? '', href: a.href ?? '', mediaType: a['media-type'] ?? '', properties: (a.properties ?? '').split(/\s+/).filter(Boolean) };
  });
  const spine = [...opf.matchAll(/<(?:opf:)?itemref\b[^>]*>/g)].map((m) => {
    const a = attrs(m[0]);
    return { idref: a.idref ?? '', linear: a.linear !== 'no' };
  });
  if (!spine.length) throw new Error(`not an EPUB: ${opfPath} has an empty spine`);
  return {
    opfPath,
    opfDir: path.posix.dirname(opfPath.split(path.sep).join('/')).replace(/^\.$/, ''),
    manifest,
    spine,
    title: textOf(opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] ?? '') || undefined,
    language: textOf(opf.match(/<dc:language\b[^>]*>([\s\S]*?)<\/dc:language>/i)?.[1] ?? '') || undefined,
  };
}

/** An href from the OPF (or a nav document at `fromDir`) as a path relative to the EPUB root, fragment dropped. */
export function resolveHref(fromDir: string, href: string): string {
  const clean = decodeURIComponent(href.split('#')[0]);
  return path.posix.normalize(path.posix.join(fromDir, clean)).replace(/^\.\//, '');
}

/** Titles by document path, from the EPUB 3 nav document and/or the NCX. */
export function readTitles(root: string, pkg: Package): Map<string, string> {
  const titles = new Map<string, string>();
  const set = (p: string, title: string) => {
    const t = textOf(title);
    if (t && !titles.has(p)) titles.set(p, t);
  };
  const nav = pkg.manifest.find((i) => i.properties.includes('nav'));
  if (nav) {
    const navPath = resolveHref(pkg.opfDir, nav.href);
    const navDir = path.posix.dirname(navPath);
    try {
      const html = fs.readFileSync(path.join(root, navPath), 'utf8');
      // The toc nav, or failing that the first nav element.
      const toc = html.match(/<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i)?.[1] ?? html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i)?.[1] ?? '';
      for (const m of toc.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
        const href = attrs(m[1]).href;
        if (href) set(resolveHref(navDir, href), m[2]);
      }
    } catch {
      // a nav the manifest lists but the archive lacks: no titles from it
    }
  }
  const ncx = pkg.manifest.find((i) => i.mediaType === 'application/x-dtbncx+xml');
  if (ncx) {
    const ncxPath = resolveHref(pkg.opfDir, ncx.href);
    const ncxDir = path.posix.dirname(ncxPath);
    try {
      const xml = fs.readFileSync(path.join(root, ncxPath), 'utf8');
      for (const m of xml.matchAll(/<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\b([^>]*)>/gi)) {
        const src = attrs(m[2]).src;
        if (src) set(resolveHref(ncxDir, src), m[1]);
      }
    } catch {
      // same
    }
  }
  return titles;
}

export interface DiscoveredChapter {
  key: string;
  path: string;
  index: number;
  title: string;
  excluded: boolean;
  excludedReason?: string;
  words: number;
}

const MIN_WORDS = 20;

/**
 * The documents to translate, in spine order. The nav document is the
 * packager's business and documents with (almost) no text — cover pages,
 * image-only plates — are excluded by default; the user can include them.
 */
export function discoverChapters(root: string): { pkg: Package; chapters: DiscoveredChapter[] } {
  const pkg = readPackage(root);
  const titles = readTitles(root, pkg);
  const byId = new Map(pkg.manifest.map((i) => [i.id, i]));
  const chapters: DiscoveredChapter[] = [];
  const keys = new Map<string, number>();
  for (const ref of pkg.spine) {
    const item = byId.get(ref.idref);
    if (!item || !/x?html/i.test(item.mediaType)) continue;
    if (item.properties.includes('nav')) continue;
    const rel = resolveHref(pkg.opfDir, item.href);
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const html = fs.readFileSync(abs, 'utf8');
    const text = textOf(html);
    const words = countWords(text);
    // The key is the agents' `<original file>`: the file's name, which names its notes and reports.
    // A duplicate name (two Text/chapter.xhtml in different folders) gets its folder in.
    const base = path.posix.basename(rel);
    const seen = keys.get(base) ?? 0;
    keys.set(base, seen + 1);
    const key = seen ? rel.replace(/[\\/]/g, '__') : base;
    const heading = textOf(html.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1] ?? '');
    const docTitle = textOf(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
    const title = titles.get(rel) || heading || docTitle || text.slice(0, 60) || base;
    const c: DiscoveredChapter = {
      key,
      path: rel,
      index: chapters.length + 1,
      title: title.slice(0, 120),
      excluded: false,
      words,
    };
    if (words < MIN_WORDS) {
      c.excluded = true;
      c.excludedReason = words === 0 ? 'no text' : `only ${words} words`;
    }
    chapters.push(c);
  }
  if (!chapters.length) throw new Error('the EPUB spine lists no (X)HTML documents');
  return { pkg, chapters };
}

// ---------- extracting, syncing, zipping ----------

export async function extractEpub(epubPath: string, dest: string): Promise<void> {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  await execFileAsync('unzip', ['-qq', '-o', epubPath, '-d', dest]);
  if (!fs.existsSync(path.join(dest, 'META-INF', 'container.xml'))) throw new Error('not an EPUB: META-INF/container.xml is missing');
}

/** Copy every file original/ has that final/ lacks, so the translated book keeps its images, styles and untranslated pages. */
export function syncAssets(originalDir: string, finalDir: string): string[] {
  const copied: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(originalDir, rel), { withFileTypes: true })) {
      const r = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(r);
      else if (!fs.existsSync(path.join(finalDir, r))) {
        fs.mkdirSync(path.dirname(path.join(finalDir, r)), { recursive: true });
        fs.copyFileSync(path.join(originalDir, r), path.join(finalDir, r));
        copied.push(r.split(path.sep).join('/'));
      }
    }
  };
  walk('');
  return copied;
}

/** What is wrong with a directory as an EPUB layout; empty when it will zip into a valid book. */
export function validateEpubDir(dir: string): string[] {
  const problems: string[] = [];
  const mimetype = path.join(dir, 'mimetype');
  if (!fs.existsSync(mimetype)) problems.push('mimetype file is missing');
  else if (fs.readFileSync(mimetype, 'utf8').trim() !== 'application/epub+zip') problems.push('mimetype file has the wrong content');
  let pkg: Package;
  try {
    pkg = readPackage(dir);
  } catch (e) {
    problems.push((e as Error).message);
    return problems;
  }
  for (const item of pkg.manifest) {
    if (!item.href || /^[a-z]+:/i.test(item.href)) continue;
    if (!fs.existsSync(path.join(dir, resolveHref(pkg.opfDir, item.href)))) problems.push(`manifest item ${item.href} is missing`);
  }
  const ids = new Set(pkg.manifest.map((i) => i.id));
  for (const ref of pkg.spine) if (!ids.has(ref.idref)) problems.push(`spine idref ${ref.idref} is not in the manifest`);
  return problems;
}

/** Zip `dir` as an EPUB: mimetype first and stored, everything else deflated. Writes to a temp name and renames. */
export async function zipEpub(dir: string, outPath: string): Promise<void> {
  const tmp = `${outPath}.tmp`;
  fs.rmSync(tmp, { force: true });
  await execFileAsync('zip', ['-0Xq', tmp, 'mimetype'], { cwd: dir });
  await execFileAsync('zip', ['-rgq', tmp, '.', '-x', 'mimetype', '-x', '*.tmp'], { cwd: dir });
  fs.renameSync(tmp, outPath);
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
    const attr = (tag: string, name: string) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
    let coverItem = items.find((tag) => /properties="[^"]*\bcover-image\b[^"]*"/.test(tag));
    if (!coverItem) {
      const coverId = opf.match(/<meta\b[^>]*name="cover"[^>]*content="([^"]+)"/)?.[1] ?? opf.match(/<meta\b[^>]*content="([^"]+)"[^>]*name="cover"/)?.[1];
      if (coverId) coverItem = items.find((tag) => attr(tag, 'id') === coverId);
    }
    if (!coverItem) {
      // Last resort: an image whose name mentions "cover".
      coverItem = items.find((tag) => attr(tag, 'media-type')?.startsWith('image/') && /cover/i.test(attr(tag, 'href') ?? ''));
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
    if (fs.existsSync(path.join(tmp, 'mimetype'))) {
      await zipEpub(tmp, epubPath);
    } else {
      const out = epubPath + '.tmp';
      fs.rmSync(out, { force: true });
      await execFileAsync('zip', ['-rXq', out, '.'], { cwd: tmp });
      fs.renameSync(out, epubPath);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
