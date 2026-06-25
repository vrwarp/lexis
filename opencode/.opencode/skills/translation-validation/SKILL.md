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

## 2. Stray Phrase Detection
- **Script Mismatch Check**: Compare source and target languages in `metadata.json`. If they use different writing scripts, prioritize fast regex or grep filtering (e.g., matching English alphabet characters in a Hanzi document) to avoid context bloat.
- **Reporting**:
  - If clean, output `{"status": "CLEAN", "stray_phrases": []}`.
  - If issues exist, output strict raw JSON listing each stray phrase, its location context, and suggested fix context.

## 3. Native Critique Review
- Perform an exhaustive, chronological line-by-line review of the draft.
- Identify stiff or awkward phrasing, style guide deviations, or forced idioms.
- Group the critique sequentially, using blockquotes for the original text and bullet points for analysis and remediation suggestions.
