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
