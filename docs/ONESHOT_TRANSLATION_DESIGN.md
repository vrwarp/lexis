# Per-Scene Translation Generation Design

> Output of a 10x critique→ideation loop on **the one-shot translation problem** (the per-scene generation in `primary-translator`). Builds on `docs/FLASH_QUALITY_PLAN.md`.
>
> **The reframe:** every fix is pushed **upstream of generation** (constraints inlined before the model commits a token) or made **external/deterministic** (grep triggers on `stray-phrase-detector`, never Flash self-judgment). The one retained "extra pass" is *externally-triggered, gated, capped, reverting* retranslation — categorically distinct from blind self-repair (see Fact 4). Happy-path Stage-B model calls per scene stay **unchanged**.
>
> Rejected (with reasons in §4): back-translation/DUAL-REFLECT and blanket best-of-N (cost-unjustified / reference metrics select the literal-but-wrong candidate), forced-JSON intermediates and verbatim-quote anchors (parse-unreliable on a tokenizer-less pipeline), and any self-critique-then-apply chain (blind iteration / self-bias on a mid-tier model).
>
> **Implementation status: FULLY IMPLEMENTED** across both harnesses (cheap bundle C1–C4 and the structural bet C5–C10, S1, S2). The pipeline *machinery* is in place; the book-specific operator assets it consumes (register-labeled `TRANSLATION_EXEMPLARS.md`, `POSITIVE_CONSTRAINTS.md`, optional `calque_prohibitions.md`, `confirmed_names.md`) are authored once per book — see the `lexical-management` skill §5. Happy-path Stage-B model calls per scene are unchanged; the only added conditional call is the gated, capped, reverting particle-retranslation (C9-R / Step 4.2b). Validate against the Ender's Game Ch.7 A/B benchmark (§3) before relying on it for a production book.

---

# Restructuring Per-Scene Translation Generation on a Flash-Class Model

## 1. RECOMMENDED DESIGN

The per-scene flow is rebuilt so that every "one-shot" axis is fixed *upstream of generation* (constraints injected before the model commits a token) or *externally* (deterministic grep triggers, never Flash self-judgment). Two retranslation paths exist; both are externally-triggered, gated, capped, and reverting — never self-critique loops.

### Per-scene generation flow (Stage B)

```
PRE-DISPATCH (stray-phrase-detector, Step 4.0a — all deterministic)
  0. source-span artifact scan → SOURCE_ARTIFACT halt           [stray-phrase-detector]
  1. structure proxies on source span: N sentences, M attributed turns, Q dialogue lines
  2. pre-compute sentence_floor = ceil(F·N), F from C5 register tag   [stray-phrase-detector]
  3. paragraph segmentation: source_paragraphs[{id,lines}]      [stray-phrase-detector]
  4. glossary-key grep on source span → in-scene Glossary Reminder block   [stray-phrase-detector → C6-inject]
        all written into verified_scenes.json

PLAN (narrative-summarizer, Stage A, already complete + staged)
  - register: <TAG> per scene block                            [narrative-summarizer → C5]
  - Scene Phrases committed forms (first-occurrence, keyword-anchored)   [narrative-summarizer → S1]
  - Domain Term Alerts for novel specialized terms            [narrative-summarizer → C6]

DISPATCH / DRAFT (primary-translator, single call, inline-prepended constraints)
  inline before source span, in saliency order:
    - FORBIDDEN CONSTRUCTIONS (syntactic + attribution calque) [primary-translator ← C1]
    - Failure-Mode Anti-Patterns (named register/slang BAD/GOOD)  [primary-translator ← C3]
    - SCENE-MATCHED EXEMPLAR (supersedes §1 default)           [primary-translator ← C5]
    - Glossary Reminder (apply exactly)                        [primary-translator ← C6-inject]
    - MANDATORY STRUCTURE floor (sentence_floor, M−1, Q−1)     [primary-translator ← C4]
    - Scene Phrases committed forms                            [primary-translator ← S1]
  generation form: paragraph-sequential under `=== SOURCE PARAGRAPH N ===`,
    emitted under `--- Paragraph N ---`, with per-paragraph re-read of the
    model's own preceding 2–3 sentences (live re-anchor)       [primary-translator ← C10]

POST-DRAFT DETERMINISTIC GATES (stray-phrase-detector, Step 4.2 — all grep, zero model)
  - PCD / banned-form / truncation scans (existing)
  - GLOSSARY_CONFLICT (BLOCKING)                               [stray-phrase-detector]
  - structure-floor regression backstop                       [stray-phrase-detector → C4/C8]
  - negation-parity grep → NEGATION_DEFICIT (REVIEW-only)      [stray-phrase-detector → C7]
  - per-paragraph clause floor → PARAGRAPH_ELISION (REVIEW)    [stray-phrase-detector → C10]
  - Particle Gate → PARTICLE_ABSENT / PARTICLE_PRESENT         [stray-phrase-detector → C9]

EXTERNALLY-TRIGGERED RETRANSLATION (before native-critique)
  - C9-R: for each PARTICLE_ABSENT scene, primary-translator retranslates the
    scene span with exemplar + clipped particle-dense anchor + BAD-list +
    glossary block + mandatory-form line; re-grep particles; accept (P≥1) or
    REVERT to held original; cap 1.                            [primary-translator ← C9-R, gated by stray-phrase-detector]
  - C8: for each Omission SCENE_ID, primary-translator retranslates that scene
    span only (never whole chapter); re-assemble affected scene.   [primary-translator ← C8]

EDIT (native-critique → final-translator, existing, floor-aware)
  - native-critique: open-ended fluency/voice repair + low-confidence negation line;
    must not suggest sub-floor merges (reads sentence_floor)   [native-critique]
  - final-translator: applies critique; prohibited from reducing below sentence_floor   [final-translator]

ASSEMBLE (stray-phrase-detector)
  - strip `--- Paragraph N ---` delimiters; write single canonical draft/<filename>
  - reverse-seam grep-subset flag → SEAM_ISSUES.md sidecar (INFO)   [stray-phrase-detector → S2]
```

Plan = Stage-A summarizer assets (register tag, scene phrases, alerts). Draft = the single `primary-translator` call, now paragraph-sequential with six inline constraint blocks. Detect = `stray-phrase-detector` greps. Retranslate = C9-R / C8, gated. Edit = native-critique → final-translator. Assemble = `stray-phrase-detector`. **Happy-path Stage-B model calls per scene are unchanged from today**; all new instruments are inline constraints, greps, or conditional gated retries.

---

## 2. RANKED CHANGES

Ranked by impact-per-unit-effort. Each names the axis fixed, the edit in both harnesses (opencode + antigravity), per-scene extra Flash calls, and parse/seam/actuator risk + mitigation.

**1. C6-inject — deterministic in-scene glossary injection.**
Fixes REPRESENTATION (domain-term generalization: 電子桌→課桌, 發射生→新兵, 閃光服→戰鬥服). Edit: `stray-phrase-detector` greps source span for `master_glossary.json` source keys (`grep -oiFf` on opencode; pre-materialized `assets/glossary_keys.txt` on antigravity, regenerated by orchestrator at A→B gate); writes a `## Glossary Reminder` block to `verified_scenes.json`; orchestrator inlines it before the source span. Cost: 0. Risk: antigravity key-list staleness (one chapter lag) → mitigated by the hard sequential Stage gate + regen at A→B. Actuator risk: extraction on `stray-phrase-detector`, not orchestrator — sound.

**2. C10 — paragraph-delimited generation + per-paragraph clause floor + boundary live re-anchor.**
Fixes GRANULARITY (sub-sentence clause elision — the deepest gap) and REPRESENTATION (autoregressive register decay) and the SEAM index-drift risk. Edit: `stray-phrase-detector` segments source by blank lines → `source_paragraphs`; orchestrator restructures dispatch into `=== SOURCE PARAGRAPH N ===` blocks with per-paragraph re-read instruction; output under `--- Paragraph N ---`; `stray-phrase-detector` counts terminal punctuation per block vs source → `PARAGRAPH_ELISION` (REVIEW-only) and strips delimiters before assembly. Cost: 0 (split is within the single existing call). Parse risk: delimiter collision with prose → mitigated by pinning `--- Paragraph N ---` in SKILL.md + one-time fixture grep verifying absence; lenient free-prose parse, not JSON (per "Let Me Speak Freely"); missed delimiter merges blocks but only fires on genuine elision. Seam risk: positive — makes omission-detector paragraph-exact.

**3. C4 — corrected two-proxy structure floor (pre-computed).**
Fixes GRANULARITY (sentence-merge, unattributed-exchange merge — the count-collapse). Edit: `stray-phrase-detector` computes N/M/Q with corrected Q-proxy `grep -cP '^[\x{201C}\x{2018}]'` (the old close-quote-absent anchor read Q=0 on rapid exchange) and pre-computes `sentence_floor=ceil(F·N)`; orchestrator inlines the MANDATORY STRUCTURE floor. Cost: 0 happy path; 1 conditional scene-scoped C8 backstop on genuine deficit. Parse risk: curly-quote byte support → mitigated by setup-time fixture that must return nonzero; per-dimension `FLOOR_UNAVAILABLE` fallback. Actuator risk: arithmetic moved off the orchestrator to `stray-phrase-detector` (Flash arithmetic at this granularity is unreliable).

**4. C1 — inline CALQUE_PROHIBITION block (syntactic + attribution calque).**
Fixes PASSES/REPRESENTATION (然而/大聲喊道/V+了 chains; plus no-added-attribution on unattributed exchange). Edit: `assets/calque_prohibitions.md` (≤6 rows); orchestrator inlines `## FORBIDDEN CONSTRUCTIONS` before source span with prose-only SCOPE clause. Cost: 0. Risk: SCOPE boundary (verse/songs/tables) un-reasonable mid-stream → named explicitly in the clause; idiomatic calque (在你頭上跳舞了) out of scope → routed to S1+C6 bridge. Actuator risk: none (operator asset, inline prepend).

**5. C5 — scene-matched continuation exemplar (real, deterministically extracted).**
Fixes REPRESENTATION (distributional register: 麻吉→親愛的朋友; stiff adult child voice) at scene opening. Edit: `narrative-summarizer` emits one `- register: <TAG>` line by word-count dominance (priority only as tiebreaker within 10%); `stray-phrase-detector` extracts via `grep -m1`; `style_guide.md §1` gains DIALOGUE/INTERIORITY and ACTION/COMMAND exemplars with the child-POV authoring spec (mid-sentence particle, dialogue→interiority transition, ≤2-clause upper bound, paragraph-rhythm note); orchestrator inlines the matched one. Cost: 0. Parse risk: tag missing → `REGISTER_TAG_MISSING`, fallback `Q≥4→DIALOGUE` else §1 default. Decay risk: handled by C10 re-anchor, not the dropped one-line reminder.

**6. C9 + C9-R — particle gate + externally-triggered scene retranslation.**
Fixes REPRESENTATION/PASSES (silent formal pass-through: 好友/老友/摯友 shipping CLEAN). Edit: `stray-phrase-detector` greps particles `[啦喔嘛吧欸哦呢囉]` on dialogue/interiority scenes with Q≥4 → `PARTICLE_ABSENT`; orchestrator queues and, before native-critique, retranslates with externally-constructed bundle (exemplar + clipped anchor + BAD-list + glossary + mandatory-form line); `stray-phrase-detector` re-greps and accepts (P≥1) or reverts to held `notes/draft_original_<id>.txt`, cap 1. Cost: 0 happy path; 0–1 per firing scene (steady state 0–1/chapter, worst case 3–6 bounded by cap-1). Risk: accept gates presence not placement → named, operator judgment on accepted scene; passes Step 4.5 regression gate bounding adequacy loss. Not blind iteration: all three Fact-4 properties hold.

**7. C8 — scene-scoped omission repair.**
Fixes GRANULARITY (within-scene omission) and closes the omission-loop/scene-chunking truncation seam (Step 4.1 was a whole-chapter call). Edit: add `verified_scenes.json` to `omission-detector` inputs; scene-partitioned (paragraph-exact with C10) mapping; `SCENE_ID` on each Omission entry; Step 4.1 retranslates the affected scene span only, never the chapter; cap-3; fallback to whole-chapter call with logged warning if `verified_scenes.json` absent; `final-translator`/`native-critique` read `sentence_floor`. Cost: 0 happy path; 1 targeted scene call (replacing a more expensive whole-chapter call) on genuine omission. Risk: re-opening truncation → eliminated by scene scope + pinned separator.

**8. C7 — negation-parity grep (detection-only).**
Fixes semantic adequacy (dropped/inverted negation). Edit: `stray-phrase-detector` counts source vs TW negations; `NEGATION_DEFICIT` REVIEW-only with the specific source paragraph identified; single conservative threshold (`assets/negation_floor.md` collapses to one float); low-confidence `native-critique` attention line. Cost: 0. Risk: a repair call would be polarity-misplaced with no deterministic placement gate (Fact-4 (c) fails) → repair dropped, detection-only.

**9. C3 — named register/slang BAD/GOOD pairs.**
Fixes named register/slang/vocative surfaces (麻吉; 在講幹話; 老媽-as-vocative). Edit: `## Failure Mode Anti-Patterns` in `TRANSLATION_EXEMPLARS.md` (register/slang/vocative only); inlined before source span; `native-critique`/`final-translator` each flag BAD-side. Cost: 0. Risk: suppresses enumerated surfaces only → cannot pass the distributional gate (owned by C5/C9/C9-R); glossary-collision avoidance via operator grep of `master_glossary.json` before adding a token.

**10. C2 — operator review gate on Stage-A nicknames.**
Fixes nickname adaptation (針刺→小針頭). Edit: `lexis-orchestrator/SKILL.md` adds an A→B gate routing names/nicknames/callsigns through one-time operator confirmation → `notes/<book>/confirmed_names.md`, decoupled from SP24 sentinel hardening. Cost: 0 model; one human asset/book.

**11. S1 / S1b — Stage-A Scene Phrases (committed forms) + ambiguous routing.**
Fixes REPRESENTATION (context-dependent committed forms, idiom equivalents via C6 bridge). Edit: Task 5 as a separate post-resolution summarizer invocation; `stray-phrase-detector` enumerates scene IDs and writes headers, verifies header-count equality + content-under-correct-header; first-occurrence + keyword-anchored application; `SCENE_PHRASE_OVERRIDE` grep; `AMBIGUOUS` → Phase 5 operator resolution. Cost: 0 Stage-B; ≤4 rows/scene + ~2 extra Stage-A calls/chapter. Risk: sentinel-emission reliability unknown → named; full-book lag for Ch.1 forms named.

**12. C5b — mid-book register-regime trigger.**
Fixes register coverage across the book. Edit: A→B gate surfaces `REGISTER_REGIME_NEW`/`CHAPTER_REGISTER_WARNING` with operator A/B classification (new regime vs recalibrate). Cost: 0.

**13. S2 — reverse-seam grep-subset flag (INFO-only).**
Fixes grep-detectable seam subset visibility only. Edit: assembly-time `stray-phrase-detector` flags tense-marker density cliff / pronoun-without-antecedent into non-canonical `SEAM_ISSUES.md`. Cost: 0. Risk: near-zero recall on Card's real seams → described honestly as a placeholder, full voice-register seam detection deferred.

---

## 3. CHEAP BUNDLE vs STRUCTURAL BET

**Cheap bundle (ship first, unconditionally): C1–C4.**
Net **+0 model calls/scene** (one conditional C4→C8 backstop). C1 bans syntactic + attribution calque at generation; C2 fixes Stage-A lexicon; C3 nets named register/slang surfaces; C4 prevents count-collapse and unattributed-exchange merge via the corrected Q-proxy and actuator-computed floor. No new agents, no canonical-artifact change, both-harness parity via inline prepend + `stray-phrase-detector` greps. **Explicit caveat:** the cheap bundle CANNOT pass the distributional-register gate (it routes Flash to unlisted formal synonyms 好友/老友/摯友) or the clause-elision gate. Do not read a cheap-bundle pass on other axes as coverage of those.

**Structural bet (fund after the cheap bundle ships and is measured in isolation): C5, C5b, C6/C6-inject, C7, C8, C9, C9-R, C10, S1, S1b; S2 flag-only.**
Stage-B happy-path cost: **zero.** Conditional: C8 (replacing a costlier whole-chapter call) and C9-R (one per `PARTICLE_ABSENT` scene, cap 1, revert) — the only new conditional Stage-B call, the deliberate Fact-4 exception. C7 and C10 are detection-only. Stage-A grows ~20–25% (~40–80 calls on a 40-chapter book: Task 5 split + C6 Alert + glossary re-reconciliation) — the honest total cost; "zero new calls" applies to Stage-B happy path only. Falls back cleanly to cheap-bundle behavior.

**Recommendation.** Ship C1–C4 now; they are pure upstream/deterministic moves with no model-call cost and no actuator risk. Then fund the structural bet, ordered by impact-per-effort: **C6-inject** (deterministic domain fix, zero authoring) and **C10** (clause elision + decay, the deepest gap) first; then the distributional-register triad **C5 + C9 + C9-R**; then C7/C8/S1/S1b/S2. The structural bet is worth funding because the two axes the cheap bundle provably cannot reach — distributional register and clause elision — are exactly the two that dominate the "stiff adult voice / silent compression" benchmark failures.

**A/B test to decide.** Re-run the *Ender's Game* Ch.7 benchmark, default-model-everywhere. Eight named failure sentences, each a binary native judgment, scored three ways — old-Pro-pipeline reference, cheap-bundle, structural-bet — by two independent raters; a split is a fail. **Partition the failure log:**
- *cheap-bundle-reachable:* syntactic + attribution calque (C1), named register/slang (C3), count-collapse (C4), lexicon (C2).
- *structural-bet-reachable:* distributional register (C5+C9+C9-R), domain terms (C6-inject/C6), clause elision (C10, detection only), negation adequacy (C7, detection only), committed forms (S1).

Each failure row carries a **partition field**; a cheap-bundle miss inside its reachable set re-seeds the relevant asset and re-runs on the benchmark chapter only. **Gate to fund S1:** a named FORM_CLASS occurs in the benchmark scene and was rendered incorrectly. **Named expected misses** (Flash ceilings the design does not claim to close — count as design-correct, not failures): per-character voice averaging on multi-voice scenes; interpretive-clause elision *repair* (C10 detects, does not fix); conditional/quantifier/referent adequacy beyond dropped negation; non-grep-detectable seams. The decision rule: fund the structural bet if it clears any structural-bet-reachable failure the cheap bundle leaves standing, at the stated conditional-call cost (steady-state 0–1 C9-R/chapter).

---

## 4. REJECTED

- **C5 single-line mid-scene re-anchor** — *blind/inert.* Inert against autoregressive conditioning at sentence 12 of 20; replaced by C10's paragraph-boundary re-read on the model's own prior tokens.
- **C7 conditional negation-repair call + register-differentiated threshold** — *blind iteration.* Flash inserts 不 at a locally plausible, not the dropped, position; count-correct but polarity-misplaced, with no deterministic placement gate (Fact-4 (c) fails). C7 is detection-only with a single threshold and a targeted-paragraph REVIEW.
- **Deterministic PCD dedupe by grep** — *parse-unreliable.* Cross-language semantic match (English Alert term vs Chinese PCD target) is impossible for a grep; reclassified as an A→B operator/LLM review step.
- **Orchestrator deterministically appends Scene-Phrase headers / computes floors / dedupes** — *actuator fiction.* The orchestrator is an LLM, not an actuator; all enumeration, counting, floor arithmetic, and header staging moved to `stray-phrase-detector`.
- **Critique-then-apply calque chain; self-selected propositional-load adequacy check; "count your output before emitting"; model self-predicted NEVER_USE generic** — *blind iteration / self-bias / incoherent for autoregression / bans the wrong token* (the web-prior generic ≠ the actual error; 電子桌's prior is 桌子, not the observed 課桌).
- **Verbatim SOURCE_FRAGMENT match + semantic-RATIONALE trigger** — *parse-unreliable / unenforceable.* A pipeline-forbidden verbatim quote silently produced no enforcement; replaced by first-occurrence + keyword-anchored application.
- **Whole-chapter omission repair (old Step 4.1)** — *parity-breaking.* Re-opens the exact truncation risk scene-chunking closed; replaced by scene-scoped C8.
- **Full grep-based voice-register seam detection; S2 voice-carry (~200-char carry)** — *parse-unreliable / parity-breaking.* Register/anaphora/tense discontinuity is not grep-detectable (near-zero recall on Card's seams); the carry propagates the stiffest register. S2 ships flag-only; voice-carry and the boundary-context call are deferred (the tool to measure their exit condition does not yet exist).
- **Idiom calque via C1** — *structurally unreachable.* The model believes it is rendering faithfully; a syntax ban can't reach it. Routed to the S1+C6 idiom-challenge bridge.
- **Forcing JSON intermediate representation** — *parse-unreliable.* Degrades small-model prose ("Let Me Speak Freely"); all intermediates are free-form/delimited and leniently parsed.
- **COMET/BLEU/xCOMET reranking; blanket best-of-N; back-translation/DUAL-REFLECT** — *cost-unjustified / selects the wrong candidate.* Reference-based metrics reward literal translationese and would select the worst candidate; selection is replaced by deterministic grep gates (particle gate, floors). Best-of-N's lever is captured more cheaply by the gated single-retry C9-R.
- **`scene-prep-agent`/zero-LLM executor, `connective_sub.py`, Stage-B PRIME, `scene-disambiguator`, POLISH pass, per-agent tier model pins, prose markers in the canonical draft** — *cost-unjustified / parity-breaking.* All stay dropped; no new agents, no new canonical artifact types, `draft/<filename>` remains the single canonical artifact.