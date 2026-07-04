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
