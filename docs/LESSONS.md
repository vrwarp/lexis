# Lessons from the reverted redesign

Between commits `ba86672` and `5aa60c8` this repo went through two large redesign efforts
("flash-quality" and "per-scene translation") that were ultimately **reverted wholesale**
back to the last known good state, because the resulting translations were markedly worse
than what the simple pipeline produced. The reverted work is still in git history
(`git log 23cba1f^2`, `git log 0e72b8b^2`) including its design docs
(`docs/FLASH_QUALITY_PLAN.md`, `docs/ONESHOT_TRANSLATION_DESIGN.md`,
`docs/BENCHMARK_CH7_FLASHPROXY.md`, `docs/LOOP_LEDGER.md` on those branches).

Any future rework of this pipeline should internalize the following before repeating them.

## 1. Do not put a cheap model on the actual translation task

The core bet of the reverted work was "make Flash the workhorse for all agents"
(`b04dd59`) and compensate with scaffolding: exemplar priors, register-matched exemplars,
in-scene glossaries, quality-gate scorers, deterministic gates, gated retranslation,
scene-scoped repair. The scaffolding grew enormous and the prose still came out subpar.
The last known good state — and the current design — pins the strong model on
`primary-translator`, `final-translator`, `native-critique`, and `metadata-generator`,
and uses the cheap tier only for mechanical/extraction work. In the Claude Agent SDK
harness that means **Opus for the translation-quality tier, Sonnet for everything else**.

## 2. Consistency must be carried as data, not exhortation

The single most instructive finding of the Flash-proxy benchmark: a per-scene model told
"be consistent with names" will re-coin a different transliteration every scene
(Bonzo → 波佐/班佐/班左). Telling it harder does not work; the *locked canonical form*
has to be injected as data. The `master_glossary.json` + strict
proper_noun/neologism adherence in `primary-translator` is the mechanism that works.
Keep the glossary authoritative and complete before production begins (hence the hard
stage barrier: no chapter enters Production until all chapters finish
Extraction/Consolidation).

## 3. Do not chunk chapters into scenes

Per-scene chunking multiplied the surface for name drift, register drift, and leaked
meta-text between scene boundaries, and required a mountain of per-scene context
injection to partially compensate. Chapters are processed whole, one at a time,
in reading order.

## 4. Weak scorers pass catastrophic defects

The in-pipeline Flash-class quality scorer issued PASS on a chapter containing a raw
paragraph of leaked English agent-reasoning. A judge that samples passages cannot see
defects between samples, and an LLM judgment call is the wrong tool for mechanical
integrity checks. The simple pipeline's deterministic-ish checks (omission-detector's
structural mapping, stray-phrase-detector's script-mismatch grep) are cheap and
sufficient; do not add an LLM "quality gate" that can wave through garbage.

## 5. Keep the pipeline lean

The 20-loop adversarial design study (`docs/LOOP_LEDGER.md` in the reverted branch)
mostly *rejected* additions — reflection loops, semantic validators, adherence auditors —
and the additions that were accepted still produced a net-worse translation and a
regression (fixing Petra's name broke Valentine's). Complexity in this pipeline has
repeatedly cost more quality than it bought. The 14-agent sequential design is the
baseline that works; change it incrementally with A/B evidence, never wholesale.
