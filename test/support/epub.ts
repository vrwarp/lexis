import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A 1x1 PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export type CoverStyle = 'epub3' | 'epub2' | 'filename' | 'none';

/**
 * Build a small but valid EPUB on disk: mimetype first and stored, a
 * container, an OPF whose cover is declared the way `style` says, one chapter
 * (padded past the 1 KB "plausible EPUB" floor) and a cover image.
 */
export function makeEpub(file: string, style: CoverStyle = 'epub3'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-epub-'));
  const w = (rel: string, body: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  w('mimetype', 'application/epub+zip');
  w(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const coverItem = {
    epub3: '<item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>',
    epub2: '<item id="ci" href="images/front.png" media-type="image/png"/>',
    filename: '<item id="img1" href="images/cover.png" media-type="image/png"/>',
    none: '<item id="img1" href="images/figure.png" media-type="image/png"/>',
  }[style];
  const meta = style === 'epub2' ? '<meta name="cover" content="ci"/>' : '';
  w(
    'OEBPS/content.opf',
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Test Book</dc:title>${meta}</metadata><manifest><item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>${coverItem}</manifest><spine><itemref idref="c1"/></spine></package>`,
  );
  const imageName = { epub3: 'cover.png', epub2: 'front.png', filename: 'cover.png', none: 'figure.png' }[style];
  w(`OEBPS/images/${imageName}`, PNG);
  w('OEBPS/chapter1.xhtml', `<html><body><p>Hello world.</p><!-- ${'padding '.repeat(400)} --></body></html>`);
  fs.rmSync(file, { force: true });
  execFileSync('zip', ['-0Xq', file, 'mimetype'], { cwd: dir });
  execFileSync('zip', ['-rgq', file, '.', '-x', 'mimetype'], { cwd: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  return file;
}

/** List an EPUB's entries in archive order with their compression method. */
export function zipEntries(file: string): { name: string; stored: boolean }[] {
  const out = execFileSync('zipinfo', [file], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((l) => /^[-d]/.test(l))
    .map((l) => {
      const parts = l.trim().split(/\s+/);
      return { name: parts[parts.length - 1], stored: parts[5] === 'stor' };
    });
}

export function readEntry(file: string, entry: string): Buffer {
  return execFileSync('unzip', ['-p', file, entry], { maxBuffer: 16 * 1024 * 1024 });
}

export interface BookOptions {
  /** Narrative chapters, each with a few paragraphs of text. */
  chapters?: number;
  /** Add a text-less cover page first in the spine. */
  cover?: boolean;
  /** Add an EPUB 3 nav document (with titles) and an NCX. */
  nav?: boolean;
  /** Put the documents under OEBPS/Text/ to exercise nested paths. */
  nested?: boolean;
}

/** A small book with several chapters, a cover page and navigation, the shape a real EPUB has. */
export function makeBook(file: string, opts: BookOptions = {}): string {
  const n = opts.chapters ?? 3;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-book-'));
  const w = (rel: string, body: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  };
  const sub = opts.nested ? 'Text/' : '';
  w('mimetype', 'application/epub+zip');
  w('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const items: string[] = [];
  const spine: string[] = [];
  const navItems: string[] = [];
  if (opts.cover ?? true) {
    w(`OEBPS/${sub}cover.xhtml`, '<html><head><title>Cover</title></head><body><div><img src="../images/cover.png" alt=""/></div></body></html>');
    items.push(`<item id="cover" href="${sub}cover.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push('<itemref idref="cover" linear="no"/>');
  }
  for (let i = 1; i <= n; i++) {
    const paras = Array.from({ length: 6 }, (_, k) => `<p>Chapter ${i}, paragraph ${k + 1}: the quick brown fox jumps over the lazy dog while the band played on and the town slept.</p>`).join('\n');
    w(`OEBPS/${sub}chapter${i}.xhtml`, `<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${i}</title><link rel="stylesheet" href="../styles.css"/></head><body><h1>Chapter ${i}: The Title</h1>\n${paras}\n</body></html>`);
    items.push(`<item id="c${i}" href="${sub}chapter${i}.xhtml" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i}"/>`);
    navItems.push(`<li><a href="${sub}chapter${i}.xhtml">Chapter ${i}: The Title</a></li>`);
  }
  if (opts.nav ?? true) {
    w(`OEBPS/${sub}nav.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>${navItems.join('')}</ol></nav></body></html>`);
    items.push(`<item id="nav" href="${sub}nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`);
    spine.push('<itemref idref="nav" linear="no"/>');
    const points = Array.from({ length: n }, (_, i) => `<navPoint id="np${i + 1}"><navLabel><text>Chapter ${i + 1}: The Title</text></navLabel><content src="${sub}chapter${i + 1}.xhtml"/></navPoint>`).join('');
    w('OEBPS/toc.ncx', `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>${points}</navMap></ncx>`);
    items.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
  }
  w('OEBPS/images/cover.png', PNG);
  items.push('<item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>');
  w('OEBPS/styles.css', 'p { margin: 0 }');
  items.push('<item id="css" href="styles.css" media-type="text/css"/>');
  w('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" xml:lang="en"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Test Book</dc:title><dc:creator>A. Writer</dc:creator><dc:language>en</dc:language></metadata><manifest>${items.join('')}</manifest><spine${opts.nav ?? true ? ' toc="ncx"' : ''}>${spine.join('')}</spine></package>`);
  fs.rmSync(file, { force: true });
  execFileSync('zip', ['-0Xq', file, 'mimetype'], { cwd: dir });
  execFileSync('zip', ['-rgq', file, '.', '-x', 'mimetype'], { cwd: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  return file;
}
