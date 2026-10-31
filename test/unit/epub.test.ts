import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { coverMime, replaceCover } from '../../src/epub.js';
import { PNG, makeEpub, readEntry, zipEntries } from '../support/epub.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lexis-epub-test-'));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

describe('coverMime', () => {
  it('maps image extensions case-insensitively and rejects others', () => {
    expect(coverMime('a.JPG')).toBe('image/jpeg');
    expect(coverMime('a.jpeg')).toBe('image/jpeg');
    expect(coverMime('cover.png')).toBe('image/png');
    expect(coverMime('x.webp')).toBe('image/webp');
    expect(coverMime('x.svg')).toBe('image/svg+xml');
    expect(coverMime('x.gif')).toBe('image/gif');
    expect(coverMime('x.bmp')).toBeUndefined();
    expect(coverMime('noext')).toBeUndefined();
  });
});

describe('replaceCover', () => {
  it('swaps an EPUB 3 cover-image and keeps mimetype first and stored', async () => {
    const dir = tmp();
    const epub = makeEpub(path.join(dir, 'book.epub'), 'epub3');
    const cover = path.join(dir, 'new.png');
    const newPng = Buffer.concat([PNG, Buffer.from('new')]);
    fs.writeFileSync(cover, newPng);
    await replaceCover(epub, cover);
    expect(readEntry(epub, 'OEBPS/images/cover.png').equals(newPng)).toBe(true);
    const entries = zipEntries(epub);
    expect(entries[0]).toEqual({ name: 'mimetype', stored: true });
    expect(entries.map((e) => e.name)).toContain('OEBPS/chapter1.xhtml');
    expect(fs.existsSync(epub + '.tmp')).toBe(false);
  });

  it('follows the EPUB 2 <meta name="cover"> convention', async () => {
    const dir = tmp();
    const epub = makeEpub(path.join(dir, 'book.epub'), 'epub2');
    const cover = path.join(dir, 'c.png');
    fs.writeFileSync(cover, Buffer.concat([PNG, Buffer.from('2')]));
    await replaceCover(epub, cover);
    expect(readEntry(epub, 'OEBPS/images/front.png').toString('latin1').endsWith('2')).toBe(true);
  });

  it('falls back to an image named like a cover', async () => {
    const dir = tmp();
    const epub = makeEpub(path.join(dir, 'book.epub'), 'filename');
    const cover = path.join(dir, 'c.png');
    fs.writeFileSync(cover, Buffer.concat([PNG, Buffer.from('3')]));
    await replaceCover(epub, cover);
    expect(readEntry(epub, 'OEBPS/images/cover.png').toString('latin1').endsWith('3')).toBe(true);
  });

  it('updates the declared media-type when the format changes', async () => {
    const dir = tmp();
    const epub = makeEpub(path.join(dir, 'book.epub'), 'epub3');
    const cover = path.join(dir, 'c.jpg');
    fs.writeFileSync(cover, JPEG);
    await replaceCover(epub, cover);
    const opf = readEntry(epub, 'OEBPS/content.opf').toString('utf8');
    expect(opf).toContain('href="images/cover.png" media-type="image/jpeg" properties="cover-image"');
    expect(readEntry(epub, 'OEBPS/images/cover.png').equals(JPEG)).toBe(true);
  });

  it('refuses an EPUB with no identifiable cover and leaves it untouched', async () => {
    const dir = tmp();
    const epub = makeEpub(path.join(dir, 'book.epub'), 'none');
    const before = fs.readFileSync(epub);
    const cover = path.join(dir, 'c.png');
    fs.writeFileSync(cover, PNG);
    await expect(replaceCover(epub, cover)).rejects.toThrow(/cover image/);
    expect(fs.readFileSync(epub).equals(before)).toBe(true);
  });

  it('refuses an unsupported cover type', async () => {
    const dir = tmp();
    const epub = makeEpub(path.join(dir, 'book.epub'));
    await expect(replaceCover(epub, path.join(dir, 'c.bmp'))).rejects.toThrow(/Unsupported/);
  });
});
