# en → zh-TW worked example

The lexis pipeline is language-pair-agnostic: all language-specific behavior is
driven by `notes/language_profile.md` (produced by the `language-profiler` agent
at init), not hardcoded in agent prompts.

`language_profile.md` here is the **filled-in example** for English → Traditional
Chinese (Taiwan) — the pair the pipeline was originally tuned on. Treat it as:

- a **template** showing the shape/fields a good profile has, and
- a **regression fixture**: running this pair should reproduce the prior zh-TW
  behavior (the deterministic checks read exactly these values).

Per-book operator assets for a real run also live alongside the book's `notes/`
(not committed here): `TRANSLATION_EXEMPLARS.md` (register-labelled), 
`POSITIVE_CONSTRAINTS.md`, `calque_prohibitions.md`, `confirmed_names.md`.
See the `lexical-management` skill §5 for their formats.
