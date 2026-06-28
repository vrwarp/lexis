# Benchmark: Running the lexis pipeline end-to-end on a Flash-class proxy

**Date:** 2026-06-28 · **Source:** *Ender's Game*, ch. 7 "Salamander" (9,893 words) · **Pair:** en → zh-TW (Traditional Chinese, Taiwan)
**Workhorse model:** `sonnet` (deliberately used as a *weaker-than-target* proxy for Gemini Flash — if the scaffolding holds on a model in this class, the real Flash workhorse holds too).
**Independent judge/architect:** `opus` (the evaluator must be stronger than the thing it grades).

This was not a design exercise — it was an **empirical run of the actual pipeline**. A background workflow (82 agents, ~2.4 M tokens) embedded the real repo agent prompts (`primary-translator`, `translation-scorer`, `omission-detector`, `stray-phrase-detector`, `native-critique`, `final-translator`) and the orchestrator's per-scene scaffolding (`FORBIDDEN CONSTRUCTIONS` → `Glossary Reminder` → `register` → `MANDATORY STRUCTURE` floor), then:

1. **Prep** — language-profiler + glossary/PCD + style-analyzer (authored the Register Exemplars) + per-scene summaries.
2. **Run v1** — per scene: draft → score → omission/stray → critique → finalize → regression-score.
3. **Evaluate v1** — opus judge scored 7 failure-classes, attributed every defect to a pipeline step, and audited the in-pipeline scorer's calibration.
4. **Improve** — opus architect proposed minimal scaffolding deltas + a v2 injection.
5. **Run v2** — reran the full scene pipeline with the improvements.
6. **Compare** — opus scored v1 vs v2 per dimension and flagged regressions.

## Headline result

The pipeline **produced a competent literary zh-TW translation of the whole chapter on a Flash-class model** — the prose, slang (Alai's banter, Petra's giria), and domain terminology were genuinely good. But v1 shipped **two catastrophic, purely-mechanical defects that no amount of prose quality excuses**, and the in-pipeline (Flash-class) scorer **passed them**. The fix for the worst defects was *deterministic gates, not a bigger model* — three of the four worst defect classes never should have depended on an LLM judgment.

## v1 → v2 (opus judge, 1–5)

| Dimension | v1 | v2 | Δ |
| :--- | :-: | :-: | :-: |
| dynamic_equivalence | 3 | 4 | +1 |
| slang_idiom | 3 | 4 | +1 |
| domain_terminology | 4 | 4 | 0 |
| register_honorifics | 4 | 4 | 0 |
| **completeness** | **2** | **5** | **+3** |
| calque_translationese | 3 | 4 | +1 |
| **name_consistency** | 3 | **2** | **−1 (regression)** |

**Net verdict:** v2 is a clear net upgrade — it eliminated the catastrophic integrity defect and lifted four dimensions — but the improvement pass *introduced* a name-consistency regression, which is itself the most instructive finding.

## The defects, and what they teach

### 1. Catastrophic: leaked English agent-reasoning in the deliverable (completeness 2→5)
v1's body contained a raw line of pipeline chatter between scenes:
> `I have all the source material in the prompt. Let me now produce the final translation, applying all critique remediations while maintaining the exemplar voice.`

A `final-translator` emitted its own preamble instead of pure target prose, and **the stray-phrase detector's per-token Latin scan didn't catch a long English *sentence*, the scorer sampled around it, and finalize ran after the only stray check** — so nothing re-examined the final. **Fix:** an `OUTPUT DISCIPLINE` hard-contract on the translators + a deterministic **Leaked-Meta-Text / long-run-Latin scan** that also runs **on `final/`** (new orchestrator Step 4.4b) + a scorer **integrity precondition** that forces FAIL on any source-language leak. v2 had **zero** Latin runs in the body.

### 2. Name romanization drift — and why a prompt instruction is not enough (name_consistency)
v1 transliterated **Bonzo** three ways (transfer-slip `波佐` vs body `班佐` ×63 vs joke `班左`) and **Petra** two ways. The architect's v2 injection *told* every scene agent "use one locked form per name… including the transfer slip." Result: v2 fixed Petra **but regressed** — **Valentine** became `瓦倫丁`/`瓦倫婷` (v1 had a consistent `瓦倫汀`) and **Salamander Army** split `蠑螈軍`/`蠑螈隊`.

**This is the key lesson of the whole run:** a per-scene mid-tier model handed the *instruction* "be consistent" but **not the actual locked form** will re-coin a different one every scene. Consistency must be carried as **data**, not exhortation. **Fix:** `glossary-manager` now emits a per-proper-noun `romanization` + `never_variants` lock; the orchestrator injects **every** proper-noun's canonical form into **every** scene's Glossary Reminder (names are book-global, not "detected in scene"); and `stray-phrase-detector` runs a deterministic **Name-Variant scan** (whole file, including structured slip/sign blocks) that emits literal `variant → canonical` repair swaps.

### 3. The Flash-class scorer was mis-calibrated *and structurally blind*
The in-pipeline scorer issued **PASS (4.0)** on the very scene that contained the leaked English paragraph. A scorer that samples 3–5 passages cannot see a defect sitting between samples, and it graded fragment fluency rather than reading the assembled scene as a reader would. **Fix:** the scorer now reads the **full artifact end-to-end** and evaluates three **integrity preconditions** (source-language leakage, proper-noun variance, unverifiable span) *before* the craft rubric — any one forces FAIL regardless of craft scores. Integrity is no longer an LLM judgment call.

### 4. Craft defects that survived fluency review (calque / dynamic equivalence)
The chapter's signature line — "they act like — history. Napoleon and Wellington." — was rendered as a dead calque (`像歷史`), and an emotional beat dropped its focalizing subject. A general "does this read naturally?" pass waved them through. **Fix:** `native-critique` now runs a mandatory **Signature & Fidelity Pass** (signature lines + calque idioms + dropped-subject beats + register slips) *before* the general flow pass.

## Caveat: one "defect" was an evaluation artifact, not a pipeline bug
The judge reported a "scope mismatch / ~40% of text has no source" and a "scope-blind scorer on scene 4." That was caused by **my eval prompt truncating the English source to 30 K of 54.6 K chars** — the judge simply couldn't see scenes 3–4's source. Both v1 and v2 in fact translate the **whole** chapter (~16.5 K Han chars). The in-pipeline scorer *did* receive each scene's full source. Lesson logged: **never truncate the source given to an evaluator.** (The scene-coverage idea is still a reasonable future guard, but the "hallucinated tail" was not real.)

## Improvements applied to the repo (both harnesses, in parity)

| Agent / skill | Change |
| :--- | :--- |
| `final-translator`, `primary-translator` | `OUTPUT DISCIPLINE` hard-contract: no preamble/meta-text, no source-language leakage, one locked name everywhere (incl. structured blocks), translate-only-the-span, self-check first/last paragraphs |
| `stray-phrase-detector` | Task 0b **Leaked-Meta-Text / long-run-Latin** gate (hard fail → regenerate); Task 11 deterministic **Name-Variant** scan with literal repair swaps; may now run on `final/` |
| `translation-scorer` | **Integrity preconditions** (leakage / name-variance / unverifiable span) read over the full artifact, forcing FAIL before the craft rubric |
| `native-critique` | Mandatory **Signature & Fidelity Pass** (signature lines, calque idioms, dropped-subject beats, register slips) |
| `glossary-manager` | Per-`proper_noun` **`romanization` + `never_variants`** lock; term-lock for in-world neologisms/slang |
| `lexis-orchestrator` | Per-scene Glossary Reminder now injects **all** proper-noun locks (global Name Lock); new deterministic **Step 4.4b Final-Artifact Integrity Gate** on `final/` before scoring |
| `ebook-packager` | Pre-packaging backstop extended to abort on source-language leakage / leaked meta-text / proper-noun variance |

Worked-example outputs (v1 with the leak, v2 clean) live under [`examples/en-zh-TW/ch7/`](./examples/en-zh-TW/ch7/).

## Follow-up: the same hardened pipeline on a *haiku* workhorse (the floor)

To find the capability floor, the **hardened** pipeline was rerun with the workhorse dropped to `haiku` (weaker than Flash; integrity gates implemented as real deterministic JS — leak scan + name-variant swap; opus as judge), then compared head-to-head against sonnet-v2.

**Verdict: haiku is below the floor — but the pipeline failed *safe*, not silent.** The scorer's integrity precondition issued FAIL on all 5 scenes; the leak gate detected leakage on every scene; the deterministic name-swap *did* fix Bonzo (波佐/班佐→邦佐 ×60), Petra, and desk. But haiku **could not stop narrating its own reasoning** into the output channel ("Let me produce the final translation…", "Based on the system prompt…") — 10 regenerations, 70 residual leaks, never one clean pass. opus scored it ~3.6/10 vs sonnet-v2 ~8.0/10 (REJECT), with a fatal recurring domain error ("frozen" soldier → 被罷免, "impeached from office"). Every dimension lost to sonnet-v2 by 2–7 points.

Two things this run proved:
1. **The guardrails work as fail-safes** — a too-weak workhorse is *blocked* (FAIL + HOLD), not shipped. That is the correct behavior.
2. **Scaffolding density can backfire on a weak model** — the judge observed the dense multi-constraint prompt "actively confused the weaker model into looping and leaking." A strong model uses the scaffolding effortlessly; a mid one needs a deterministic *post-process* safety net, not denser prompts.

**Flash implication (opus):** Flash sits between haiku and sonnet, so expect **partial recovery, not parity** — competence errors (frozen→罷免, calques) scale with strength and Flash should clear most (~6–7), but *instruction-following collapse* (looping, meta-leak, name drift) does not scale smoothly and is the load-bearing risk. Validate Flash specifically on (a) one clean pass / no meta-leak and (b) name-lock + the 凍結/罷免-class domain terms, backed by a deterministic name-lock swap + meta-text stripper.

**Two bugs this run surfaced in the gates themselves (now fixed):**
- **Overlapping name-swap corruption** — a `never_variants` form that is a *prefix of the canonical* (`敵方的門在下` vs canonical `敵方的門在下面`) double-applied and produced `敵方的門在下面面`. Fixed: `glossary-manager` must not emit a `never_variants` form that is a substring of the canonical; `stray-phrase-detector`/`-fixer` apply swaps longest-first, non-overlapping, and skip any `Find` that is a substring of its `Replace`.
- **Blind leak-regeneration loops** on a weak model. Fixed: Step 4.4b now **strips** leaked agent-narration deterministically (`stray-phrase-fixer` Instruction 0) *before* regenerating, and only regenerates if the strip leaves a real omission or the leak persists; HOLD (never ship) if it still leaks.

The contaminated haiku transcript + result JSON are retained as evidence in the working scratchpad (not committed — it is a corrupted artifact, not a reference translation).
