# Flash-Quality Improvement Plan

> Produced from an **empirical benchmark** (an Ender's Game Ch.7 translation by the old Pro-using pipeline vs. the current Flash-everywhere pipeline, judged for native Taiwanese conformity) refined through a **10x critique→ideation loop**. The benchmark showed Flash-everywhere regressed on dynamic equivalence, localized slang, domain terminology, child register, and completeness (a `（行已截斷）` truncation artifact even leaked into output).
>
> **The load-bearing insight:** the pipeline could *detect* low quality (the scorer) but had no Flash-capable mechanism to *produce* literary quality, because the critique/finalize agents are now also Flash. The fix is to transplant a positive generation-time signal — a complete prior passage Flash *continues* — plus deterministic (grep/human-authored) repair, rather than asking Flash to perceive its own translationese.
>
> This is a design proposal. The book-specific authored assets it references (the exemplar passages, the term table + replacement-sentence templates) are one-time curation (free where Sample 1 exists; otherwise one Pro pass per register regime). See `docs/LOOP_LEDGER.md` lineage and `docs/REDESIGN.md` for the surrounding architecture.

---

# Making lexis Flash-Everywhere Match the Pro Benchmark — Final Deliverable

## Framing: the one load-bearing insight

The benchmark proves a single mechanism gap. The Pro pipeline produced literary dynamic equivalence, localized slang, domain-term localization, child register, and completeness *at generation time*. Flash-everywhere kept the scaffolding that can **detect** those failures but has **no Flash-executable mechanism to produce or repair** them, because the agents that would have to perceive translationese (`native-critique`, `final-translator`) are now also Flash and cannot see what they would need to fix. Every improvement below is ranked by how directly it restores a *positive production* mechanism, not another detector. The governing rule throughout: **never ask Flash to perceive its own translationese, generate a dynamic equivalent in the repair path, or quote source text it must reproduce exactly.** Each such operation moves to (a) a human-authored constraint Flash consumes, (b) a complete exemplar Flash continues, or (c) a deterministic bash operation by a bash-capable agent.

---

## 1. RANKED IMPROVEMENTS (highest leverage first)

### #1 — Complete Sample-1 passage as the primary register prior (the exemplar prior)
**Benchmark failure fixed:** #6 (stiff, adult, formal child register) primarily; materially reduces #1 (親愛的朋友, 說屁話), #3, #4; mitigates #5-style compression.
**Exact change (both harnesses):** New artifact `notes/TRANSLATION_EXEMPLARS.md` holding 2–3 *complete, consecutive* source→Sample-1 passage pairs (a peer-solidarity dialogue block showing 麻吉 in situ; a sci-fi-object physical-action sentence showing 闔上電子桌; one Alai dialogue turn + one interior-monologue block showing 啦/喔 particles and nominalization collapse with sentence count preserved). `style-analyzer.md` embeds this file verbatim as the opening section of `style_guide.md` (already read by `primary-translator`, `final-translator`, `native-critique`, `stray-phrase-fixer`), so it reaches every literary agent through existing plumbing. Injected as the **first content** `primary-translator` reads, framed: "PRIOR TRANSLATED PASSAGE — you are continuing the same translation project; match this register, slang, sentence rhythm, particle usage, and nominalization avoidance exactly. If your draft reads more formally than this, revise it."
**Mechanism:** A complete passage sets the output token distribution *at the moment of generation* — child voice, particle density, and slang become active in working memory rather than recalled rules. This is qualitatively different from a WRONG/RIGHT pair read thousands of tokens earlier, which shifts only the exact enumerated surface form and leaves the distributional failure (好朋友, 關係很好, 兩人很要好) untouched. Flash's stylistic *continuation* quality is far higher than its rule-following or self-critique quality; this is the one thing it does reliably. Zero inference-token cost (Sample 1 already exists). The effect is probabilistic and decays with distance — which is exactly why #3 (scene chunking) is its prerequisite.

### #2 — Bash-verified scene chunking on structural boundaries (prerequisite for everything)
**Benchmark failure fixed:** #5 (catastrophic truncation + （行已截斷） artifact + lost opening frame); enables the exemplar prior (#1) to stay in effective attention.
**Exact change (both harnesses):** `narrative-summarizer` emits a fenced `SCENE_BOUNDARIES` JSON array of `{scene_id, start_description, end_description}` as **free-text content descriptions, never verbatim quotes** ("scene begins after Bernard throws food at Ender"), plus a separate `CHAPTER_FRAME` structural element for pre-scene framing dialogue. The bash-capable orchestrator (or `stray-phrase-detector` where the orchestrator lacks `run_command`) resolves each description: grep the source for 3–4 high-salience words, extract 5-line windows to `notes/chapter_N_anchor_candidates.txt`, and a bounded one-shot Flash call ("which candidate matches? output only the line number") selects among 3–5 verbatim candidates. Verified ranges written to `notes/chapter_N_verified_scenes.json`. `primary-translator` translates scene by scene, emitting `=== SCENE {id} === … === END SCENE {id} ===`.
**Mechanism:** Whole-chapter drafting (4,000–6,000 chars) triggers lost-in-the-middle truncation — the literal cause of （行已截斷） and the dropped opening. A ~400-word scene fits Flash's reliable window with the exemplar and constraint header still in attention. Describing content is Flash-reliable; quoting source is not — so the unreliable step (Flash quoting an anchor it must reproduce for grep resolution) is removed entirely, killing v10's non-converging malformed-retry loop that silently collapsed to one-shot drafting. Collision ties → request a longer description for that scene only; unresolved → `SCENE_BOUNDARY_UNRESOLVED` blocks Stage B. The orchestrator **never silently falls back to whole-chapter drafting.**

### #3 — Persistent Positive-Constraint Document with PCD-reconciled locked glossary
**Benchmark failure fixed:** #1, #3, #4 (terminology drift and domain-term generalization: 課桌, 新兵, 戰鬥服, 小針頭, 親愛的朋友, 說屁話); cheapest fix for terminology AND tonal drift.
**Exact change (both harnesses):** New `notes/POSITIVE_CONSTRAINTS.md`, human-authored once. SECTION A = locked term table with columns `SOURCE | USE_ONLY | NEVER_USE | DISAMBIGUATING_ACTION | ALWAYS_REPLACE | FULL_SENTENCE_TEMPLATE | SCOPE`. `glossary-manager` is injected with override semantics: write `USE_ONLY` as `canonical_translation`, never a `NEVER_USE` form. Orchestrator [bash] reconciles `master_glossary.json` to the PCD idempotently before Stage B, guarded by a `RECONCILIATION_INCOMPLETE` sentinel that blocks Stage B on a mid-loop crash (so 電子桌-fixed-but-新兵-not never ships).
**Mechanism:** Injected everywhere, the PCD converts `primary-translator`'s existing "glossary is absolute" rule from a liability into an asset — canon now equals the curated answer. `ALWAYS_REPLACE=true` (for forms wrong in every context: 說屁話, 老媽-as-peer-vocative, 小針頭, 戰鬥服, 親愛的朋友) closes v10's false-ambiguity gap where an empty discriminator was misread as AMBIGUOUS. `SCOPE` (default all chapters; narrowable to `[ch:1-8]`) keeps 新兵 bannable for *Launchies* without mis-flagging a genuine later military unit — making the PCD maintainable across a 24-chapter book.

### #4 — Zero-generation REPAIR_BLOCKs: detector pre-authors, fixer only swaps
**Benchmark failure fixed:** repair path for #1, #2 (vocative calque), #3, #4 — and closes v10's contradiction where the *detector* was asked to generate 騎到你頭上啦，兄弟, the exact translationese-generation operation that already failed.
**Exact change (both harnesses):** `FULL_SENTENCE_TEMPLATE` is a **human-authored** complete Chinese replacement sentence per SECTION A term (~8 terms in Ch.7, ~15 min once, or one Pro pass on the PCD). `stray-phrase-detector` (the one bash-capable actuator: `grep_search` + `run_command` + `view_file`) locates each violation via `grep -n`, reads SECTION A via `view_file`, and emits a REPAIR_BLOCK whose `REPLACE_SENTENCE_WITH` is **copied** from `FULL_SENTENCE_TEMPLATE`. `stray-phrase-fixer` (bash/grep-deny) does one literal `multi_replace_file_content(old=FIND_VERBATIM_LINE, new=REPLACE_SENTENCE_WITH)` — no paraphrase, no generation — then adjusts only ±1-sentence particles/pronouns if anaphora breaks. The detector re-greps the seam neighbors after the fix (gives `[SEAM_CHECK]` a real consumer).
**Mechanism:** The verb+noun co-repair (關上→闔上 *and* 課桌→電子桌) and the idiom de-calque are deterministic because the human authored the entire target sentence once. The only micro-generation left anywhere in the repair path is the ±1-sentence seam adjustment — Flash's reliable range. Where a template doesn't structurally fit (e.g. 針刺 in arbitrary narration), the detector falls back to a token-swap REPAIR_BLOCK (`FIND_EXACTLY: 小針頭 / REPLACE_WITH: 針刺`), still a generation-free substring swap.

### #5 — Deterministic detector routing + scene-retry + CJK truncation/CHAPTER_FRAME sentinels
**Benchmark failure fixed:** #5 closure on both harnesses (the （行已截斷） artifact, the missing scene, the lost opening frame); deterministic routing for #1–#4.
**Exact change (both harnesses):** `stray-phrase-detector` runs a deterministic grep loop, **CJK truncation artifact FIRST**: `grep -nP '（[^）]*(?:截斷|省略|未完|已截|略去|內容省略)[^）]*）|……（'` plus 【】/bracket variants — the backstop the Latin-only scan structurally could not see. Then: chapter-opening + `CHAPTER_FRAME` sentinel (verify resolved frame span present in first 5%); `NEVER_USE` grep with `ALWAYS_REPLACE`→unconditional REPAIR_BLOCK and `DISAMBIGUATING_ACTION` (±5 lines) routing for `false` rows (absent → `AMBIGUOUS_HIT` to operator, never silently mis-fixed); corrected two-pass vocative grep with a parent-identification guard (`VOCATIVE_AMBIGUOUS` when ±10 lines contain 母親/他的媽媽); `grep -c '=== SCENE'` completeness → `MISSING_SCENE`. On surviving `TRUNCATION_ARTIFACT`/`MISSING_SCENE`, orchestrator resolves the failing scene's **bash-verified** line range and passes that span as **inline extracted source text** to `primary-translator` ("translate ONLY this scene; previous attempt was incomplete; never emit placeholders"), exemplar still injected. Cap 2 retries/scene.
**Mechanism:** A grep finding 親愛的朋友 in a PCD-banning draft is a deterministic bit — fires on every Sample-2 failure, never on Sample 1, no calibration. The scene-retry is reliable precisely because the line range was bash-verified in #2, not Flash-quoted; a 300–500-word scene that truncated under full-chapter pressure almost always completes in isolation. This closes #5 on **both** harnesses without Pro.

### #6 — Best-of-2 with grep selection for AMBIGUOUS-prone scenes
**Benchmark failure fixed:** reduces the plain-narration 課桌/desk AMBIGUOUS rate (the second-most-important failure that would otherwise dominate operator review); secondary lever on #1, #3, #4.
**Exact change (both harnesses):** For scenes the Stage-A pre-check flags as containing SECTION A terms with no nearby `DISAMBIGUATING_ACTION`, run `primary-translator` twice (temp ~0.85, nucleus sampling for diversity) and have the detector select the output with fewer `NEVER_USE` grep hits (`grep -c` over the assembled banned-pattern). Tie → first output.
**Mechanism:** The "literary judge" is a grep count, not Flash perception — the perception-free instantiation of the best-of-N lever. Reference-free literal metrics (COMET/BLEU/xCOMET) would reward translationese; a banned-form count rewards localization. Cost is ~2× tokens on a minority of scenes. Composes with #1: the exemplar shifts the prior, best-of-2 selects on the deterministic residue.

### #7 — Positive-presence (SHOULD_CONTAIN) + paragraph-ratio gates
**Benchmark failure fixed:** the silent `STATUS:CLEAN` chapter that ships 親愛的朋友 in *every* peer context because no banned form *and* no required form appears (#1, #6); gross interiority/framing compression (#5-adjacent).
**Exact change (both harnesses):** After concatenation, detector [bash]: `grep -cP '[啦喔嘛吧欸]'` for particle presence in dialogue-bearing chapters; for each `USE_ONLY` term confirmed-in-source by `CHAPTER_HARD_CASES`, grep the draft — absence fires `POSITIVE_PRESENCE_MISSING` and a **targeted scene-retry** (hard gate, not advisory); paragraph-ratio compression guard `grep -c '^$'` source vs concatenated draft, ratio < 0.75 → `COMPRESSION_WARNING` into escalation.
**Mechanism:** No `NEVER_USE` grep can see a *missing* required form. Presence checks surface the silent register failure — the chapter that violates nothing yet localizes nothing. The paragraph-ratio guard catches the benchmark's collapsed framing dialogue and gross 6→3-sentence interiority collapse that no other Antigravity mechanism detects.

### #8 — Demoted contrastive pairs + tightened register directives (SECTION B/C)
**Benchmark failure fixed:** deterministic backstop for #1–#4; structural harm-reduction for #6.
**Exact change (both harnesses):** SECTION B keeps 15–20 single-pattern WRONG/RIGHT pairs (SOURCE / exact Sample-2 WRONG / Sample-1 RIGHT) but **demoted** below the exemplar — their job is now narrow: pre-condition against the exact banned forms and feed the detector's PATTERN labels. SECTION C tightened: 情緒/情況/感動 *removed* from the protected DO-NOT-TOUCH set (Sample 2 proves Flash wrongly produces 他情緒低落 in child-POV); only 性格/性質/性別/感受 stay locked. Per-character voice reclassified to **opencode-only upside** (no evidence Flash holds 3-adjective differentiation over 4,000 chars from a directive).
**Mechanism:** The pairs carry the burden the exemplar can't guarantee (exact banned-form avoidance); the exemplar carries the burden the pairs can't (distributional register). Honest split, not redundancy.

### #9 — native-critique-as-diff-against-reference
**Benchmark failure fixed:** restores a *functioning* critique signal for #6 that Flash can actually execute.
**Exact change (both harnesses):** `native-critique.md` reads the B1 exemplar first, then for each dialogue/interiority line outputs `STIFF_LINE` entries comparing the line *against the exemplar* with a concrete rewrite — never vague fluency notes.
**Mechanism:** Converts an impossible abstract-register judgment ("is this stiff?") into a concrete diff-against-reference ("is this stiffer than this passage?") — Flash's reliable comparison frame. Left unchanged, the agent gives false assurance that critique is occurring.

### #10 — Re-pin opencode literary agents to Pro (free upside, NOT load-bearing)
**Benchmark failure fixed:** #1–#4 and the structural bulk of #6 on the opencode harness only.
**Exact change (opencode only):** Set `model: google/gemini-3-pro-preview` in `primary-translator.md`, `final-translator.md`, `native-critique.md`, `metadata-generator.md`, `local-lexicographer.md`, `style-analyzer.md`; move to the Pro row of `AGENTS.md` (~7 lines). Antigravity `agent.json` has no model slot and `settings.json` exposes only `{enabled: bool}`, so per-agent Pro is structurally impossible there — hence #1–#9 must all work on pure Flash.
**Mechanism:** On opencode, Pro genuinely perceives translationese, register, dynamic equivalence, and child voice. Retained only as free upside; the entire core defense is harness-portable and Pro-independent.

---

## 2. HONEST CEILING — where pure Flash cannot reach Pro, and where a minimal frontier touch is warranted

### Where pure Flash structurally cannot reach Sample-1 quality

1. **Unenumerated register drift (好朋友, 關係很好, 兩人很要好 for "bestie").** The exemplar prior (#1) shifts the probability of these toward 麻吉, but the effect is probabilistic and decays with distance. No `NEVER_USE` grep enumerates the open set of stiff-but-not-banned phrasings. On Antigravity this is shifted but **not guaranteed**.

2. **Silent within-scene interiority compression (6→4 sentences, paragraph count intact).** The deepest undetected class. The monologue exemplar sets a length prior, chunking shrinks the window, and the paragraph-ratio guard catches *gross* collapse — but sub-paragraph compression with intact structure ships silently. Pure Flash cannot perceive that interiority was thinned.

3. **Per-character voice differentiation** (Alai warm 啦/喔; Dink sardonic-short; Bernard bluster) over 4,000+ chars. No evidence Flash maintains 3-adjective differentiation from a directive; it rides only on whatever the exemplar's single Alai turn carries by continuation.

4. **Novel repurposed terms with smooth normal-verb first uses** ("the Launchies lined up", "he stared at his desk"). The anomalous-verb discovery heuristic fires on "snaps shut" but not on normal verbs — the irreducible Antigravity discovery residual.

5. **Plain-narration ambiguous domain terms** (desk-as-datapad with no nearby disambiguating action). Best-of-2 reduces frequency; the remainder routes to operator review because auto-fix is reliable only with Pro perception.

The root cause is uniform: **pure same-model self-refine self-biases** — a weak Flash estimator hallucinates errors and cannot perceive translationese-as-a-number. Grounding refinement in an external signal (grep, the exemplar, human-authored templates) is how Flash gets pushed *toward* frontier quality, but the residual classes above have **no external deterministic signal** and **no positive exemplar coverage** strong enough to guarantee them.

### Where a minimal, leveraged frontier-model touch is warranted — and cost-justified

The principle: spend frontier tokens **only** where they have maximal leverage per dollar — one-time offline prep, or the hard tail of low-scoring chunks — never on the bulk inference path.

**(A) One-time offline distillation into prompts — the highest-leverage frontier spend.**
- **Exemplar curation** (`TRANSLATION_EXEMPLARS.md`): already free (Sample 1 exists), but for chapters with no Pro precedent, **one Pro pass per register-shift chapter** (e.g. Ender among adults in Command School) authors one additional curated passage. Cost: ~1 Pro call per register regime across a 24-chapter book — a handful total. Justified because few-shot exemplars are empirically the single strongest fix for over-literalness on weak models (Command-R cross-lingual line pass-rate 1.1%→95% with 5-shot), and the cost amortizes across every chunk in that register.
- **`FULL_SENTENCE_TEMPLATE` authoring**: one Pro pass over the PCD produces every human-authored replacement sentence. Cost: one call. Justified because it removes *all* generation from the repair path forever — every subsequent Flash repair is a free deterministic swap.

This is the cost-justification core: a **constant, one-time** frontier spend buys a **per-chapter, per-chunk** quality lift on pure Flash inference. The marginal cost approaches zero as the book lengthens.

**(B) Hard-tail escalation of low-scoring chunks — bounded, signal-gated.**
Frontier inference is warranted **only** on chunks that survive all deterministic gates AND fail an external quality signal:
- On **opencode**, `translation-scorer-final` (Pro, one invocation/chapter) blocks register/compression-degraded chapters; `ESCALATE` routes the *specific failing spans* to a Pro `final-translator` for span-repair with full context. Cost: one Pro scoring call/chapter + Pro repair only on the failing tail.
- For chunk selection, a **LiTransProQA-style literary judge** (tone/voice/equivalence) reranks — explicitly NOT COMET/BLEU/xCOMET, which reward literal translationese and would escalate exactly the wrong chunks.

Justified because (1) it is gated to the minority of chunks that fail an *external* signal, so the frontier spend tracks actual residual risk rather than blanket coverage; (2) the failing classes (unenumerated drift, silent compression, per-character voice) are precisely the ones with no Flash-executable defense, so the frontier dollar buys quality that is otherwise unreachable at any Flash token budget; (3) escalation is span-scoped, not chapter-scoped, so even a triggered escalation spends frontier tokens only on the degraded region.

**On Antigravity, frontier inference is structurally unavailable**, so the honest ceiling is stated plainly in `QUALITY_NOTE`: default Flash-everywhere = Sample-2 register on the residual literary classes; the only routes to Pro-tier quality are running the book through opencode or operator repair of `ESCALATED` chapters. Dialogue-dense chapters — the benchmark's own failure class — are exactly the ones that hit the invocation budget and become operator work items. This is a deliberate, stated trade.

---

## 3. IMPLEMENTATION SKETCH — top 5 improvements, with harness-parity

### Top-5 selected: exemplar prior (#1), scene chunking (#2), PCD glossary (#3), zero-generation repair (#4), deterministic routing + scene-retry (#5)

#### Improvement #1 — Exemplar prior
- **New data artifact:** `notes/TRANSLATION_EXEMPLARS.md` — 2–3 full source→Sample-1 passage pairs (peer-solidarity dialogue, sci-fi-object action sentence, Alai turn + interior-monologue block with sentence count preserved).
- **Changed skill:** `style-analyzer.md` embeds `TRANSLATION_EXEMPLARS.md` verbatim as the opening section of `style_guide.md` — the document every literary agent already reads. This is the parity mechanism: the exemplar reaches both harnesses through existing plumbing with no schema change.
- **Changed agents:** `primary-translator.md`, `final-translator.md`, `native-critique.md` consume the exemplar as first content with the "continue this translation project" frame.
- **Orchestrator:** assembles the exemplar at primacy in the injected header.
- **Parity:** opencode injects as first user-turn content; Antigravity injects as a per-chapter, namespaced temp system-prompt section. Identical content, identical ordering.

#### Improvement #2 — Bash-verified scene chunking
- **Changed agent:** `narrative-summarizer.md` emits fenced `SCENE_BOUNDARIES` (description-based, no quotes), a separate `CHAPTER_FRAME` element, and `CHAPTER_HARD_CASES` (full quoted source sentence for any line containing a SECTION A SOURCE, plus mundane-noun-with-anomalous-verb candidates).
- **New orchestrator steps (SKILL.md):** [bash] description→candidate grep → `notes/chapter_N_anchor_candidates.txt` → bounded Flash line-number selection → `notes/chapter_N_verified_scenes.json`; collision → longer-description request; unresolved → `SCENE_BOUNDARY_UNRESOLVED` blocks Stage B; malformed JSON → re-run the *description* step, never collapse to one-shot.
- **Changed agent:** `primary-translator.md` emits `=== SCENE {id} === … === END SCENE {id} ===`, completes each scene fully, never emits placeholders.
- **New data artifacts:** `notes/chapter_N_verified_scenes.json`, `draft/chunks/` (new write permission).
- **Changed skill:** `ebook-packager` concatenates chunks into `draft/<filename>` and strips delimiters.
- **Parity:** the [bash] steps run on the orchestrator where it has `run_command`; on Antigravity (orchestrator bash not assumed) they route through `stray-phrase-detector`, which holds `run_command`/`grep_search`. Same resolution, different actuator.

#### Improvement #3 — PCD-reconciled glossary
- **New data artifact:** `notes/POSITIVE_CONSTRAINTS.md` (SECTION A locked table with ALWAYS_REPLACE, FULL_SENTENCE_TEMPLATE, SCOPE; demoted SECTION B pairs; tightened SECTION C).
- **Changed agent:** `glossary-manager.md` — PCD injection + override semantics (write USE_ONLY, never NEVER_USE).
- **New orchestrator steps:** [bash] idempotent reconciliation of `master_glossary.json` to PCD, guarded by `RECONCILIATION_INCOMPLETE` sentinel (written before the loop, cleared only after the final row; presence blocks Stage B); header assembly at primacy (exemplar → SECTION A → SECTION B → SECTION C → recency anti-truncation line); `HEADER_INVALID` unless all four blocks present and non-empty; Stage A→B operator gate that appends `CANDIDATE_TERM | [OPERATOR: FILL]` stubs and writes `STAGE_B_BLOCKED` for any new term with no PCD row.
- **Parity:** PCD is flat Markdown read via existing `notes/` access — identical on both harnesses, zero schema migration. Reconciliation [bash] routes through `stray-phrase-detector` on Antigravity.

#### Improvement #4 — Zero-generation repair
- **Changed agent:** `stray-phrase-detector.md` — emits STATUS line; for each violation, `grep -n` locate + `view_file` SECTION A → REPAIR_BLOCK with `REPLACE_SENTENCE_WITH` **copied** from FULL_SENTENCE_TEMPLATE (or token-swap fallback where the template doesn't fit); post-fix seam re-grep.
- **Changed agent:** `stray-phrase-fixer.md` — `multi_replace_file_content(old=FIND_VERBATIM_LINE, new=REPLACE_SENTENCE_WITH)`; no generation, no paraphrase; ±1-sentence particle/pronoun seam adjustment only; emits `[SEAM_CHECK]`.
- **Data artifact:** REPAIR_BLOCKs are transient detector→fixer messages; FULL_SENTENCE_TEMPLATE lives in the PCD.
- **Parity:** both agents and their permission profiles (detector: grep+bash+view; fixer: replace-only) exist identically on both harnesses; the repair path is fully deterministic and Pro-independent.

#### Improvement #5 — Deterministic routing + scene-retry
- **Changed agent:** `stray-phrase-detector.md` — CJK truncation grep FIRST; CHAPTER_FRAME + opening sentinel; NEVER_USE grep with ALWAYS_REPLACE/DISAMBIGUATING_ACTION routing and `AMBIGUOUS_HIT`; corrected two-pass vocative grep + parent guard (`VOCATIVE_AMBIGUOUS`); `grep -c '=== SCENE'` completeness.
- **Changed agent:** `final-translator.md` — reads detector report first; any REPAIR_BLOCK/TRUNCATION_ARTIFACT/MISSING_SCENE/CHAPTER_FRAME_MISSING/VOCATIVE_CALQUE → REPAIR MODE consuming handed spans; reads `escalation_required.md`.
- **New orchestrator steps:** scene-retry loop — read `original/<chapter>`, resolve failing scene's bash-verified range, pass as inline extracted source to `primary-translator`; cap 2/scene; `grep -c '=== SCENE'` confirms resolution before `ebook-packager`; escalation exit writes `notes/<filename>.escalation_required.md` + `STATUS: ESCALATE`; scene-count-derived invocation budget (`base + N_scenes_anchor + N_ambiguous×2 + retry caps`).
- **Changed gate:** `ebook-packager` dual-abort on CANONICAL_VIOLATION **or** TRUNCATION_ARTIFACT_DETECTED.
- **Parity:** routing is deterministic grep, identical on both harnesses. The escalation *exit* differs only in destination — opencode routes `ESCALATE` to Pro `final-translator` span-repair; Antigravity routes to operator review with concrete spans + violated constraint. The *detection and blocking* are identical; only the repair authority differs, which is the honest, structural harness gap.

### How both harnesses stay in parity
- All shared artifacts are **flat Markdown/JSON in `notes/`** read through existing access — no harness-specific schema.
- All shared logic is **deterministic grep/bash** in the agents that hold those grants on *each* harness (orchestrator on opencode; `stray-phrase-detector` as bash proxy on Antigravity).
- The exemplar reaches every literary agent via **`style_guide.md`**, which both harnesses already read.
- The **only** intentional divergences are: opencode Pro re-pinning (#10) and Pro escalation/scoring (§2B) as free upside; Antigravity `QUALITY_NOTE` + namespaced/crash-safe injection. Every core defense (#1–#9) is byte-identical in logic across both.
- Parity is verified by the pre-commit empirical gates: detector on Sample 2 → REPAIR_BLOCKs for 課桌/親愛的朋友/新兵/戰鬥服/小針頭/說屁話 + VOCATIVE_CALQUE; detector on Sample 1 → STATUS: CLEAN — the same deterministic bits on both harnesses.

**One line:** make a complete Sample-1 passage the primary register prior (the missing positive production lever), move all repair-path generation out of Flash into human-authored `FULL_SENTENCE_TEMPLATE`s the detector copies and the fixer swaps verbatim, replace Flash anchor-quotation with description-plus-bash-verified scene resolution so chunking holds, and gate everything with deterministic grep routing, positive-presence checks, and dual EPUB aborts — while spending frontier tokens only on one-time offline exemplar/template distillation and signal-gated hard-tail span escalation, and stating plainly that Antigravity register and silent interiority-compression remain Pro-gated, now narrowed by a production lever rather than only measured.