---
name: lexical-management
description: Procedures for extracting and managing lexical context, including Table of Contents (TOC) extraction, project metadata, local lexicon extraction, and master glossary updates. Trigger this skill whenever you deal with glossary synchronization, term extraction, metadata creation, or table of contents generation.
---

# Lexical & Glossary Management Skill

Detailed guidelines for establishing the linguistic infrastructure and maintaining vocabulary consistency across the project.

## 1. Table of Contents & Reading Order
- Scan for EPUB TOC documents (`toc.ncx` or XHTML `.opf`).
- Map each file in reading sequence into `notes/contents.json` with keys: `index`, `filename`, `title`.
- Fall back to sorting files numerically or chronologically by content headers if navigation files are missing.

## 2. Style Guide & Metadata Creation
- Define `notes/metadata.json` with target dialects, age group, key themes, and contrastive grammar rules (e.g., subject- vs. topic-prominence, pronoun drops).
- Sample 3-5 middle chapters to extract author's stylistic fingerprint, generating `notes/style_guide.md`.

## 3. Local Lexicon Extraction
For each section, parse raw content to identify proper nouns, neologisms, slang, and metaphors. Save under `notes/<filename>.lexicon.md` in Markdown format, beginning with `STATUS: COMPLETE`. Each entry uses the structure:

```markdown
## Term: <term>
- **Category:** <category>  (one of: proper_noun, neologism, idiom, slang)
- **Example Sentence:** "<exact sentence>"
- **Usage Notes:** <notes detailing emotional intent and context>
```

Markdown format is required over raw JSON to avoid Flash-model parse failures that would be indistinguishable from agent failure.

## 4. Master Glossary Consolidation
Update `notes/master_glossary.json` using the local lexicon:
- Maintain aliases as separate pointer entries referencing the main term.
- Set a baseline translation for `idiom` and `slang` terms but authorize downstream translators in `usage_notes` to apply dynamic equivalence.
- Append files containing the term to the `sections` list.
- Merge duplicate terms without altering established translations unless a definitive revelation dictates correction.
