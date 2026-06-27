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

## 5. Localization Assets (authored once, per book)

These two optional, human/operator-authored Markdown files are the highest-leverage quality levers for a mid-tier (Flash-class) workhorse. They are flat Markdown read by agents through their existing `notes/` access, so they work identically on both harnesses. The pipeline runs without them, but quality on register, slang, and domain terminology is materially lower without them.

### 5a. Register Exemplars — `notes/TRANSLATION_EXEMPLARS.md`
- Contains **2-3 complete, consecutive source→target passage pairs** that demonstrate the desired target voice: at minimum one casual peer-dialogue block (showing localized slang/particles in situ) and one interior-monologue block (showing sentence rhythm and nominalization avoidance, with sentence count preserved — do not compress).
- Authored once before any chapter runs, from an existing gold translation of a sample passage, or by an operator/editor. This is the single strongest register lever: a model **continues** a high-quality passage far more reliably than it follows an abstract style rule.
- `style-analyzer` embeds this file verbatim as the opening `## Register Exemplars (continue this voice)` section of `style_guide.md`, so it reaches every literary agent (`primary-translator`, `final-translator`, `native-critique`, `stray-phrase-fixer`) through existing plumbing.
- Format is free Markdown; recommended:
  ```markdown
  ## Exemplar 1 — casual peer dialogue
  SOURCE:
  "..."
  TARGET:
  「...」
  ## Exemplar 2 — interior monologue
  ...
  ```

### 5b. Positive-Constraint Document — `notes/POSITIVE_CONSTRAINTS.md`
- A locked term/phrase table that pre-authors the correct target forms so downstream agents never have to *generate* a dynamic equivalent under pressure (the operation a mid-tier model fails). One row per repurposed/specialized term or banned calque. Recommended columns: `SOURCE | USE_ONLY | NEVER_USE | DISAMBIGUATING_ACTION | ALWAYS_REPLACE | FULL_SENTENCE_TEMPLATE | SCOPE`.
  - `USE_ONLY` = the canonical target (e.g. a futuristic "desk" → 電子桌, "Launchies" → 發射生); `NEVER_USE` = the wrong literal/generic form to ban (課桌, 新兵); `ALWAYS_REPLACE=true` for forms wrong in every context; `FULL_SENTENCE_TEMPLATE` = a complete human-authored replacement sentence the repair path copies verbatim; `SCOPE` = chapter range a ban applies to (default all).
- `glossary-manager` reconciles `master_glossary.json` to this document (writing `USE_ONLY` as the canonical translation, never a `NEVER_USE` form). Authored once; see the translation-validation skill for how the detector/fixer consume it for zero-generation repair.

### 5c. Optional per-scene-design assets (from `docs/ONESHOT_TRANSLATION_DESIGN.md`, "cheap bundle")
- **`notes/calque_prohibitions.md`** (optional) — a short `## FORBIDDEN CONSTRUCTIONS` list of target-language calque patterns to ban at generation time, each with a preferred natural alternative. `primary-translator` carries sensible Mandarin defaults built in; this file *extends/overrides* them and the orchestrator inlines it immediately before the source span (most salient position). Keep it to ≤6 rows.
- **`## Failure Mode Anti-Patterns`** — an optional section inside `notes/TRANSLATION_EXEMPLARS.md` listing named BAD → GOOD pairs for register/slang/vocative surfaces (e.g. `親愛的朋友 → 麻吉`; `說屁話 → 在那邊講幹話`). `primary-translator` avoids the BAD side; `native-critique`/`final-translator` flag it. Scope it to *enumerated* surfaces only — distributional register is owned by the exemplar prior, not this list.
- **`notes/confirmed_names.md`** — operator-confirmed canonical names/nicknames/callsigns, produced by the one-time Name Confirmation Gate (orchestrator Phase 3.5) before Stage B, so a derisive nickname is adapted (針刺) rather than rendered literally (小針頭).
