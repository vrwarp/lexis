---
name: epub-handling
description: Handlers for EPUB manipulation, including disbinding (extracting zip contents into original/) and outbound packaging (repackaging final/ contents into a valid .epub). Trigger this skill whenever you need to unzip or zip/package an ebook.
---

# EPUB Handling Skill

Procedural guidelines for extracting EPUB contents and packaging them back into a compliant EPUB file.

## 1. Disbinding (EPUB Extraction)
When extracting a `.epub` file into the `original/` folder:
- **Extract Command**: Propose `unzip -q <file.epub> -d original/` to preserve folder structures.
- **Verification**: Check for standard files:
  - `mimetype` in the root.
  - `META-INF/container.xml`.
  - Content OPF file (`.opf`) containing manifest, metadata, and spine.
  - Navigation documents (`toc.ncx` or XHTML navigation files).

## 2. Packaging (Valid EPUB Zipping)
To create a valid, spec-compliant EPUB, the compression order must be executed precisely:
1. **Mimetype First**: Zip the `mimetype` file at the root of the folder first, with **no compression** (`-0` flag) and no extra attributes.
   ```bash
   zip -0Xq translated_book.epub mimetype
   ```
2. **Remaining Contents**: Zip the rest of the folders and files with standard compression, excluding `mimetype`.
   ```bash
   zip -rgq translated_book.epub * -x mimetype
   ```
3. Run this from within the target directory where the finalized files are synchronized.
