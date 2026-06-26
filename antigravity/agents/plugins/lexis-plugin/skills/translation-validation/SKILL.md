---
name: translation-validation
description: Guidelines for auditing and reviewing draft translations. This covers structural paragraph mapping, omission audits, regex-based script checking for stray untranslated phrases, and native critiques. Trigger this skill whenever you perform audits, validation checks, or critiques of translated drafts.
---

# Translation Validation & Auditing Skill

Procedures for evaluating draft translations, identifying content gaps, scanning for untranslated source phrases, and conducting stylistic reviews.

## 1. Omission Auditing
- **Structural Mapping**: Create a `<scratchpad>` block sequentially matching source paragraphs to draft paragraphs. Map out any misalignments.
- **Auditing**: Locate any missing sentences or clauses, focusing intensely on the middle 80% of the document.
- **Reporting**: 
  - If complete, output `STATUS: COMPLETE`.
  - If incomplete, output `STATUS: INCOMPLETE` and a markdown list detailing the original missed text, insertion point in draft, and reasoning.

## 2. Stray Phrase Detection, Truncation & Banned-Form Repair
- **Truncation-artifact scan FIRST**: grep the draft (script-independently) for placeholder/truncation markers (e.g. `（…截斷…）`, `……（`, `[truncated]`, `【…省略…】`). Any hit means the draft is incomplete → `STATUS: TRUNCATION_ARTIFACT`; the orchestrator must re-translate the affected span and never package a placeholder. A Latin-only stray scan cannot see a CJK placeholder, so this scan is separate and unconditional.
- **Script Mismatch Check**: Compare source and target languages in `metadata.json`. If they use different writing scripts, prioritize fast regex or grep filtering (e.g., matching English alphabet characters in a Hanzi document) to avoid context bloat. Use `grep -n` for line numbers.
- **Banned-form (PCD) detection → zero-generation repair**: if `notes/POSITIVE_CONSTRAINTS.md` exists, grep each `NEVER_USE` form; for each hit emit a `## Repair Block` that **copies** the row's `FULL_SENTENCE_TEMPLATE` (or a `Find Exactly / Replace With` token swap). The detector never generates a replacement — it copies the pre-authored target. The fixer then applies repair blocks as **literal substitutions** before translating any remaining stray phrases, so no dynamic-equivalent generation happens in the repair path (the operation a mid-tier model is unreliable at).
- **Reporting** (Markdown, written to `notes/<filename>.stray_report.md`):
  - If clean, output exactly: `STATUS: CLEAN`
  - If issues exist, output `## Repair Block N` entries then `## Stray Phrase N` entries, closing with `STATUS: ISSUES_FOUND`. Truncation → `STATUS: TRUNCATION_ARTIFACT`. Unrecoverable scan failure → `STATUS: ERROR`.
  - The orchestrator gates progression on the last standalone `STATUS:` line only — no JSON parsing required.

## 3. Native Critique Review
- Perform an exhaustive, chronological line-by-line review of the draft.
- Identify stiff or awkward phrasing, style guide deviations, or forced idioms.
- Group the critique sequentially, using blockquotes for the original text and bullet points for analysis and remediation suggestions.
