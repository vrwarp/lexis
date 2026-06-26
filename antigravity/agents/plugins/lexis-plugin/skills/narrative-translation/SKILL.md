---
name: narrative-translation
description: Core translation procedures, including drafting initial translations, applying style guides, dialogue naturalization, lexical constraints (glossary categories), inserting stray-phrase fixes, and final consolidation of critique. Trigger this skill during primary drafting, fixing stray phrases, or finalizing translations.
---

# Narrative Translation Skill

Guidelines for translating, refining, and polishing text blocks into a natural target-language equivalent while maintaining strict context.

## 1. Initial Drafting
- Read the source text, `notes/style_guide.md`, `notes/metadata.json`, and `notes/master_glossary.json`.
- Apply strict category rules:
  - **`proper_noun` and `neologism`**: Adhere strictly to the master glossary translation.
  - **`idiom` and `slang`**: Adapt via dynamic equivalence to fit the tone. Prioritize intent and conversational realism over word-for-word accuracy.
- naturalize dialogue by focusing on target locale cadence, sentence structure, and organic speech patterns.

## 2. Stray Phrase Fixing
- Check `notes/<filename>.stray_report.md` for untranslated fragments.
- Perform targeted modifications in the draft without corrupting the surrounding sentence flow or losing the context of the initial translation.

## 3. Final Consolidation
- Reconcile the original text, the draft in `draft/`, and the critique in `critique/<filename>.critique.md`.
- Implement suggestions from the native critique to resolve any remaining awkwardness.
- Perform final syntax polish, ensuring the paragraph structure matches the original layout perfectly.
