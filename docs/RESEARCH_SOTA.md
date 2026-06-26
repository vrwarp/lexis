# State-of-the-Art Book Translation: A Design Reference

A condensed, verified digest of how high-quality literary translation is produced by humans and by LLM systems, plus the evaluation machinery that gates it. Claims flagged as overstated or mis-cited in adversarial review have been corrected or dropped; remaining citation labels are the corrected ones.

---

## 1. How Humans Produce Quality Literary Translation

### 1.1 Theory that maps to practice
Three axes, largely parallel, govern every per-passage decision:

- **Nida — formal vs. dynamic (functional) equivalence.** Formal = preserve source form/structure (literal, source-oriented). Dynamic = reproduce *equivalent effect* on the target reader (natural, target-oriented). (Nida; *Domestication and Foreignization*, JLTR)
- **Vermeer/Reiss — skopos theory.** The *purpose* of the translation, fixed by the commission/brief, determines the method. "Good" = adequacy to the intended function, not abstract fidelity. Skopos is the meta-rule that decides *when* to domesticate vs. foreignize. (TPLS, *Skopos Theory*)
- **Venuti — domestication vs. foreignization.** Domestication = fluent, transparent, translator-invisible (the Anglo-American default Venuti critiques). Foreignization = deliberately retains strangeness to signal the source culture.

These map onto each other: **dynamic/domesticating ↔ formal/foreignizing**. Professionals do **not** pick one globally; they decide per passage, with skopos as the governing brief.

### 1.2 The real professional workflow is multi-pass and role-separated
A book passes through distinct stages, deliberately separating *translator brain* (drafting) from *editor brain* (revising) — never both at once:

1. Initial draft by the translator.
2. **Self-revision** after a time gap.
3. **Bilingual/comparative revision** — target checked sentence-by-sentence against source for transfer errors and omissions.
4. **Monolingual/unilingual revision** — target read alone for fluency, voice, rhythm; often read aloud or via TTS.
5. **Other-revision** — a *separate* reviser gives a fresh-eyes pass the self-reviser cannot, because translators are blind to their own choices.
6. **Copyedit** (mechanics, consistency, house style).
7. **Proofread** on the final draft only.

A **cold reading** (target read fresh, ideally by someone who has never seen it) is the recognized final fluency check. (Mossop, *Revising and Editing for Translators*; PEN America; J-En Translations)

> **Empirical support, with a caveat:** Macken et al. (EAMT 2022, EN-NL) found their post-editing and revision stages produced *different types and amounts* of editing — directionally confirming that comparative and monolingual passes do distinct work. Note: that study did not run a clean controlled bilingual-vs-monolingual contrast, so treat it as supportive rather than dispositive.

### 1.3 Mossop's 12 revision parameters (the canonical rubric)
Four groups — a machine pipeline can decompose these into separate targeted passes. Comparative (source-anchored) re-reading catches the first two groups; unilingual (target-only) re-reading catches Language.

| Group | Parameters | Checked by |
|---|---|---|
| **Transfer** | Accuracy, Completeness | Comparative |
| **Content** | Logic, Facts | Comparative |
| **Language** | Smoothness, Tailoring, Sub-language (genre/register), Idiom, Mechanics | Unilingual |
| **Presentation** | Layout, Typography, Organization | (Format-level; often skippable for prose EPUB) |

Accuracy is treated as the single most important parameter. Experienced revisers check parameters near-simultaneously — but the parameter *set* is exactly what a pipeline can split into single-objective passes.

### 1.4 Literary quality dimensions professionals prioritize
From LiTransProQA (built with 7 professional literary translators): six dimensions — **Grammar/Linguistics, Literary Devices, Cultural Understanding/Adaptation, Tone & Authorial Voice, Consistency & Coherence, General Equivalence.** Ablation: **Tone & Authorial Voice is the single most load-bearing dimension**, followed by General Equivalence. Translators deliberately separate literary evaluation from mechanical accuracy. (Zhang et al., *LiTransProQA*, EMNLP 2025, arXiv:2505.05423)

### 1.5 Hard-case tactics (named strategy menus)
Giving a translator (or model) an explicit, named strategy set produces more deliberate choices than "translate naturally." Critically, **a hard case need not be solved in place — compensation lets you re-introduce the effect at a nearby low-stakes spot.**

- **Dialogue / idiolect / register.** Distinguish geographic, social, temporal dialect, standard language, and **idiolect** (a character's recurring tics/syntax). Dialect carries non-decorative function (status, identity, origin, humor). Documented failure mode: **standardization/leveling** (flattening into neutral target language), which destroys characterization. Expert fix = **compensation** (re-encode the contrast via lexis/syntax/controlled non-standard markers), kept internally consistent per character across the whole book. (JJMLL; *Idiolects of Literary Characters*)
- **Puns/wordplay — Delabastita (1996).** ~8-9 techniques: PUN→PUN, PUN→PUNOID (rhyme/alliteration/irony), PUN→NON-PUN (keep a sense, lose the play), PUN→ZERO (omit), direct COPY, **ZERO→PUN (compensate by adding wordplay elsewhere)**, plus editorial footnotes. Ordered preference in practice: PUN > PUNOID > paraphrase > footnote.
- **Idioms/humor.** Functional equivalence — recreate the *effect*: substitute an equivalent target idiom > paraphrase the sense > new joke fitting the characters > last-resort gloss (which dilutes immediacy). (cf. Baker's idiom strategies)
- **Proper names / honorifics.** Sit on the domestication–foreignization axis: RETENTION (most foreignizing) → transcription → partial translation → addition → REPLACEMENT (most domesticating). Honorifics (-san, T/V, titles) encode social structure. **Must be a book-level policy decided once and applied uniformly** — this is where inconsistency is most visible. (Sato, TPLS)
- **Culture-specific items (CSI) — Aixelá.** A graded scale, not a binary: CONSERVATION (repetition → orthographic adaptation → linguistic translation → **extratextual gloss** [footnote] → **intratextual gloss** [weave explanation into running text — invisible, preferred in fiction]) → SUBSTITUTION (synonymy → limited/absolute universalization → naturalization → deletion → autonomous creation). Newmark adds 6 CSI categories. The footnote-vs-gloss-vs-domesticate question is a **slider per item**.
- **Poetry/verse — Lefevere's seven strategies.** Phonemic, literal, metrical, rhymed, blank-verse, prose, interpretation/imitation. No free lunch — choose explicitly per poem and disclose. (Macrothink IJL)

### 1.6 Consistency tooling (the dominant book-length risk)
"The primary cause of rework is inconsistent terminology." Three pillars:

1. **Style sheet / style guide** — tone, register, formality, voice, dialect treatment, what stays untranslated, formatting/spelling conventions.
2. **Terminology glossary / termbase** — approved source→target pairs for names, places, invented terms, recurring epithets, with **locked target equivalents** (name-locking is the single cheapest consistency mechanism).
3. **Translation memory** — segment-level source→target pairs reused via exact + fuzzy match.

(Lokalise; Lionbridge; Smartling)

### 1.7 Retranslation as an operation
Berman's hypothesis (classics warrant a fresh translation every ~20-30 years; first translations more domesticating, later ones more foreignizing) is **empirically contested** (~60% of studies refute it). Practical takeaway: "retranslation" is a legitimate quality *operation* — a fresh independent pass can be regenerated and compared, and the domesticating↔foreignizing dial is a **tunable knob**, not a fixed setting. (Meta-analytical critique of Berman, ResearchGate)

---

## 2. SOTA LLM Translation Techniques

### 2.1 Document-level / long-context (the most robust finding)
**Translate at paragraph/scene granularity, never sentence-by-sentence.** Karpinska & Iyyer (WMT 2023, arXiv:2304.03245), ~350 annotator hours, MQM span annotation across 18 language pairs: whole-paragraph translation yields **fewer mistranslations, grammar errors, and stylistic inconsistencies** and resolves pronouns/register/discourse cohesion.

Critical caveats that shape implementation:
- **Critical errors persist** even at paragraph level — dominated by content **omissions** and voice/register drift; human review remains necessary. (Same paper notes omission is *more prominent* for paragraph-level — so longer chunks are not a free lunch.) Note: in that paper's own error counts, **mistranslation dominates by frequency**, not omission; omission is emphasized qualitatively as the persistent *critical* class.
- **Long-context quality cliff.** "Lost in the middle" (Liu et al.) causes drop/hallucination in the middle and tail of long inputs; repetition/looping also rises with length. **A model's advertised context window is NOT a safe chunk size.** Use moderate chunks (paragraph-to-scene; a practical working range is ~256–512 tokens for QE validity, with a soft ceiling around 1–2k source tokens) split on **source structural boundaries** (paragraph/scene/dialogue turns), never mid-sentence. Carry the previous chunk's tail (source + finalized target) as read-only context across the seam to keep tense/anaphora continuous, but emit only the new chunk.
- More document context measurably improves zero-pronoun resolution and terminology consistency (Wang et al., *Document-Level MT with LLMs*, arXiv:2304.02210), up to a reliability ceiling guarded by output-vs-input length checks.

### 2.2 External multi-level memory (strongest long-doc consistency pattern)
**DelTA** (Wang et al., ICLR 2025, arXiv:2410.08143) wraps a sentence/segment-streaming translator in four memories, with **linear** memory growth:
1. **Proper Noun Records** — freeze each proper noun's translation on **first occurrence**; at each step inject **only** the entries whose terms appear in the current segment.
2. **Bilingual Summary** — source-side captures *content, domain, style, tone*; target-side summarizes prior output; refreshed every ~20 sentences.
3. **Long-Term Memory** — last ~20 sentence pairs, from which a retriever selects the most relevant as few-shot exemplars.
4. **Short-Term Memory** — last ~3 pairs injected verbatim (anaphora/tense continuity at the seam).

Result: up to **+4.58 consistency** and **+3.16 COMET** over baselines. (Note: DelTA itself streams sentence-by-sentence with continuously updated memory — it is *not* an independent-chapters system; the memory *idea* transfers cleanly to a chunked pipeline. Its retriever is LLM-based, not embedding-similarity — the embedding-similarity retrieval-of-exemplars approach comes separately from arXiv:2406.07081, which retrieves demonstrations similar to a generated summary embedding.)

### 2.3 Agentic reflection (single model)
**Andrew Ng's translation-agent** — the canonical three-step loop on one LLM: translate → reflect/critique → improve, chunked over long text. It is a sound, cheap (~3× calls), model-agnostic baseline.
> Correction to a common overstatement: in Ng's actual code, `country`/locale is injected only into the *reflection* prompt, and there is **no** glossary, register, or genre parameter (glossary handling is listed as an open problem); chunking is by token count, not paragraph. Passing a glossary/style sheet/genre into both prompts and chunking on structural boundaries are *good additions*, but they are not "Ng's exact prompts."

**Self-Refine** (Madaan et al., NeurIPS 2023) and **Reflexion** (Shinn et al., NeurIPS 2023) are the generic parents (generator/feedback/refiner; Actor/Evaluator/Self-Reflection with episodic memory).

**TEaR** (Translate–Estimate–Refine, arXiv:2402.16379, NAACL 2025 Findings): the Estimate step has the LLM emit **MQM-style error annotations** (type + severity), and Refine corrects against them. ~+2.48 COMET avg over 16 pairs. Two load-bearing findings:
- **Gains saturate at ~1 refinement round**; iterating further *degrades* (COMET 79.50 → 79.29 → 79.20 across iters 1/2/5), because weak models hallucinate errors in the Estimate step. → **Cap refinement at 1–2 iterations.**
- **The Estimate step is the bottleneck.** A weak estimator produces false critiques and the Refine step then hurts quality. Targeted, located, error-labeled repair beats generic "make it better" (e.g., fixing a located "untranslated text" span gave large COMET gains vs. tiny gains from a generic mistranslation rewrite).

### 2.4 Pitfalls of pure self-refinement (and the fix)
- **Self-bias amplification.** Xu et al., *Pride and Prejudice* (ACL 2024, arXiv:2402.11436): on MT, self-refine improves fluency but inflates the model's *self-estimate* while true quality stagnates/falls. Larger models are more resilient (not immune).
- **Intrinsic self-correction degrades reasoning** without an external signal (Huang et al., ICLR 2024, arXiv:2310.01798) — more relevant to reasoning than translation fluency, but a real warning against unbounded looping.
- **Fix: ground feedback externally.** Ki & Carpuat (NAACL 2024, arXiv:2404.07851) feed MQM-style fine-grained error spans into post-edit prompts. **Honest caveat:** their substantial gains required **fine-tuning** on the feedback; *prompting-only* gains from fine-grained spans were marginal (~+0.04 BLEU at 10-shot) and on sentence-level WMT MQM data, not literary. So for a prompt-only pipeline, treat external error feedback as a sensible discipline, not a guaranteed large lift.
- **Back-translation as a free verifier.** DUAL-REFLECT (ACL 2024, arXiv:2406.07232): back-translate the draft, diff against the original to surface dropped/altered meaning, revise only divergences. +1.18 COMET over ChatGPT baseline. A reference-free omission/mistranslation detector needing no extra model.

### 2.5 Multi-agent role decomposition (SOTA for literary/long-form)
**TransAgents** (Wu et al., TACL 2024 / EMNLP 2024 demo, arXiv:2405.11804) simulates a publishing house: CEO, Senior/Junior Editor, Translator, Localization Specialist, Proofreader.
- **Preparation stage** builds a 5-part guideline = **{glossary, book summary, tone, style, target audience}**, where tone/style/audience are set by the Senior Editor from a randomly sampled chapter and the book summary aggregates per-chapter summaries. This guide is **injected into every subsequent prompt**.
- **Execution stage** per chapter: Translate → Junior+Senior Editor review → Localization/cultural adaptation → Proofread → Senior Editor cross-chapter QC.
- Two reusable primitives: **Addition-by-Subtraction** (one agent maximizes detail, another prunes — used to build a tight glossary) and **Trilateral Collaboration** (Action/Critique/Judgment, where critique/judgment run *without* full history to avoid context degradation).
- Result: **preferred over GPT-4 and even over human references** in human/LLM preference, **at ~80× lower cost than human translation**, *despite low d-BLEU (~25 vs ~47)* — i.e., it diverged from word-for-word references in favor of readability. **Human preference was genre-dependent: ~77.8% for fantasy/romance, only ~39.1% for sci-fi.**
> Caveat: TransAgents' "beats human references" headline came from a monolingual preference protocol that drew methodological criticism. Read the role-specialization and prep-stage patterns as solidly useful; read the "surpasses humans" magnitude cautiously.

**DRT** (Deep Reasoning Translation, ACL 2025 Findings, arXiv:2412.17498) targets similes/metaphors via a Translator/Advisor/Evaluator inference loop and distills long chain-of-thought into smaller models (+7–8 BLEU, +3 COMET on figurative sentences). The selective deep-reasoning *loop* transfers to inference-time use without distillation; note DRT operates at sentence level on figurative text, so it does not by itself validate a full four-role literary pipeline.

### 2.6 Terminology injection (probabilistic — needs enforcement)
- **Prompt-injected glossaries reduce but do not deterministically eliminate drift** — a probabilistic decoder cannot be guaranteed by the prompt alone. "Name-locking deterministically eliminates drift" is **false** in the strict sense; enforcement needs a post-hoc check/replacement step.
- **Constrained decoding does not guarantee insertion and often *hurts* literary quality** (word-alignment errors propagate; blocking words causes collateral mistranslation). Recall is language-pair-dependent. (arXiv:2310.05824, *Terminology-Aware Translation with Constrained Decoding and LLM Prompting*, WMT 2023)
- **Winner: translate-then-revise.** Draft normally, then a focused second pass injects only the terms actually present in the source and rewrites mismatches (**Translate-and-Revise**, arXiv:2407.13164 — a distinct paper from 2310.05824; the two are often conflated). Inject **whole inflected target forms** (not lemmas) so the model adapts morphology — a well-documented terminology-MT practice (Copy-and-Inflect / target-lemma annotation), though not itself a finding of either cited paper.

### 2.7 Self-generated translation knowledge (MAPS)
**MAPS** (Multi-Aspect Prompting and Selection, TACL, arXiv:2305.04118): before translating, the model self-generates **keywords + topic + a relevant demonstration**, translates conditioned on that knowledge, then **QE-selects** among candidates. Measurably reduces hallucination, ambiguity, mistranslation, awkward style, untranslated text, **and omission** — and works on weak models (Alpaca, Vicuna).

---

## 3. Quality Evaluation Frameworks & Metrics (Automated Gates)

### 3.1 The decisive caveat for literary text
**Surface and generic neural metrics systematically prefer literal MT over good human literary prose.** LiTransProQA (EMNLP 2025) and LITEVAL-CORPUS (arXiv:2410.18697) show GEMBA-MQM, CometKiwi, and xCOMET-XL/XXL prefer human literary translations over machine output only **6–27%** of the time (vs. MQM-human ~45%); GEMBA-MQM could barely distinguish human from machine. **Gating literary output on COMET/xCOMET/GEMBA alone will reward flat, literal output and push the generator toward translationese.** Never tune the generator against these.

### 3.2 Human/analytic frameworks
**MQM** (Lommel 2014; Freitag et al. 2021) is the gold standard analytic scheme: annotators mark error **spans**, assign **category** + **severity**, sum severity weights. Top dimensions: Accuracy {mistranslation, omission, addition, untranslated, over/under-translation}, Fluency {grammar, spelling, punctuation, register, inconsistency, encoding, unintelligible}, Terminology {inappropriate-for-context, inconsistent-use}, Style {awkward}, Locale, plus Non-translation. **Standard WMT weighting: Minor=1, Major=5, Critical/Non-translation=25.** Segment score = (1/N)·Σ(weights); no fixed pass/fail threshold (project-defined). **ESA** (Kocmi et al. 2024) is a lighter-weight successor. Use MQM as the **internal vocabulary** so all signals (GEMBA spans, xCOMET spans, human spot-checks) are comparable. DQF/LISA QA are the industry ancestors, now unified into MQM-DQF.

### 3.3 Automatic string metrics are weak — use only as breakage guards
BLEU and chrF measure surface n-gram overlap against a reference. WMT22 metrics findings: *"Stop using BLEU — neural metrics are better and more robust"* (BLEU ~70.8% vs ~84-85% for neural metrics on system-pairwise accuracy). Fatal for literary text, where creative reinterpretation legitimately diverges from any reference. **Keep BLEU/chrF only to catch gross breakage** (empty output, format corruption, catastrophic divergence), never as a quality bar. d-BLEU is a coarse document-level signal only.

### 3.4 Neural metrics & reference-free QE (the book-pipeline enablers)
With no human reference (the EPUB situation), reference-free **Quality Estimation** is the key:
- **CometKiwi-22** (IST-Unbabel, WMT22, arXiv:2209.06243) — scores (source, hypothesis) only; strongest pre-LLM QE. Built on XLM-R with a **512-token combined source+target limit** → keep chunks small enough to stay valid.
- **xCOMET** (TACL 2024, arXiv:2310.10482) — unifies a sentence score **with MQM-style error-span detection + severity** in one model; runs in reference-based **and** reference-free (QE) modes; sizes XL (3.5B) / XXL (10.7B) run on a single GPU. Strong at detecting **critical errors and hallucinations** (AUROC >95 for detached hallucinations at XXL) → use its spans to drive targeted repair and **hard-reject any chunk with a CRITICAL span.**
- **COMET-22**, **BLEURT** — reference-based neural metrics (far better human correlation than BLEU); useful only when a reference exists (e.g., regression vs. a prior edition).

### 3.5 LLM-as-judge / GEMBA
**GEMBA-MQM** (Kocmi & Federmann, WMT 2023, arXiv:2310.13988): a fixed **three-shot, language-agnostic, reference-free** prompt asks the LLM to emit MQM error spans (category + severity); score = Σ weights (critical/major/minor = 25/5/1). Hit ~96.5% system-pairwise accuracy on WMT23. Documented operational rules:
- **Drop the "Locale convention" category** — the authors found GPT over-fires it on correct text (e.g., flagging Euro currency in Czech).
- **Pin the judge model version** — silent updates break reproducibility.
- Best used as a **coarse adequacy/correctness gate, not the literary-quality judge.**

### 3.6 The literary-quality judge (layer on top)
**LiTransProQA** (arXiv:2505.05423, EMNLP 2025): reference-free, training-free LLM-as-judge asking **25 professional-translator-vetted yes/no/maybe questions** across the 6 dimensions (§1.4), mapping answers to 1/0/0.5 and averaging (optionally weighted by translator-importance votes). It **beat all SOTA metrics** (+0.07 correlation, +15–23 adequacy points), **works on open/mid models** (LLaMA3.3-70B, Qwen2.5-32B — no frontier judge required), and **the simple "Vanilla" prompt beat the heavily-instructed variants.** Highest-impact aspects: **Tone & Authorial Voice** and **General Equivalence.** Run at paragraph/scene level to catch voice drift QE metrics miss.

### 3.7 Calibrating gate thresholds
Reason in **deltas calibrated to human-perceptible thresholds**, not arbitrary absolutes (Kocmi et al., *Navigating the Metrics Maze*, ACL 2024, arXiv:2401.06760). COMET/Kiwi scores are **not comparable across language pairs and not interpretable as absolute quality** — do not hardcode "accept if CometKiwi > 0.8."
> Correction: the paper's actual system-level pairwise-accuracy thresholds for CometKiwi-QE-22 are ~0.67 (80% accuracy) and ~0.85 (90%); the ~0.5-range figure (~+0.56) is for reference-based **Comet-22**, a different metric. (The "+0.53 CometKiwi" figure circulating elsewhere conflates the two.) These are **system-level** deltas, so applying them to gate single re-translation candidates is an extrapolation.

### 3.8 Pitfalls of COMET/QE as a gate
(*Pitfalls and Outlooks in Using COMET*, arXiv:2408.15366) — empty/copied/wrong-language outputs can score **deceptively high**; scores shift across package/precision versions; QE variants are more sensitive to translationese/paraphrase. **Gate design:** (1) cheap string pre-screen first (non-empty, length ratio vs source, language-ID, copied-source/untranslated detection); (2) pin exact metric checkpoint versions; (3) threshold on human-perceptible deltas; (4) **never tune the generator against the gate metric.**

### 3.9 Document-level / discourse evaluation
Sentence-level metrics miss book-length problems. WMT24 literary track added a **Discourse Awareness** axis (consistency, word choice, anaphora, coherence) (arXiv:2412.11732). Maintain a cross-chunk consistency check (running glossary/TM of names, terms, honorifics, register) — CometKiwi/xCOMET are sentence-level and will **not** catch chapter-12-vs-chapter-1 name drift. **SEGALE** (arXiv:2509.17249) is the current book-length scoring recipe: segment → align (Vecalign + BGE-M3) → score (COMET/MetricX), with **null-alignment ratio** as an under-/over-translation signal. (Note: SEGALE is an evaluation/alignment metric — claims attributing specific "4k/8k quality cliff" numbers to it are unfounded; the long-context degradation phenomenon is real but documented elsewhere.)

### 3.10 Reserve human MQM/ESA for calibration
Periodically have a professional MQM/ESA-annotate a small sample, correlate against the automated gate (Kendall tau / pairwise accuracy), and re-tune thresholds, detect metric drift after a model update, and confirm the gate isn't gamed by metric-pleasing literal output.

---

## 4. Raising a Mid-Tier / Flash-Class Model to Near-Frontier Quality

The heavy lifting is in the **scaffold** (memory, glossary, multi-pass, selection), not raw model size. Highest-leverage levers, in priority order:

### 4.1 Best-of-N sampling + QE selector (the single biggest lever)
Generate N=4–8 candidates per chunk via temperature/nucleus sampling, then select with a **reference-free QE selector** (CometKiwi/xCOMET-QE, or a pairwise LLM-judge tournament with **order-swap** to kill position bias). QE reranking is **O(N)** and competitive with O(N²) MBR. Documented: calibrated small models can rival much larger ones at a fraction of the cost.
> Honest provenance: arXiv:2504.19044 demonstrates *training-time likelihood calibration* (the model's own log-likelihood becomes the quality proxy) and a "~200× faster" (speed, not cost) 13B-rivals-70B result — a *different mechanism* than best-of-N+external-selector. The best-of-N+QE-rerank lever is independently well-established (Fernandes et al., *Quality-Aware Decoding*, NAACL 2022). For literary chunks, **rerank by a blend of xCOMET-QE (adequacy/no-critical-errors) + a LiTransProQA-style literary score** so you don't reward the most literal candidate.

### 4.2 Right-size the chunk (paragraph/scene, never sentence, never whole chapter)
Paragraph-level beats sentence-level (§2.1); whole-chapter inputs trigger lost-in-the-middle omission/hallucination and exceed QE token limits (CometKiwi's 512-token cap). Split on structural boundaries, small overlap context, stitch.

### 4.3 Persistent book bible injected into every chunk
A one-time prep pass (sampling 1–3 chapters) emits a structured guideline: **locked glossary (names/places/invented terms with target equivalents) + tone/style/register sheet + rolling plot/character-state summary + per-character voice cards.** Inject into *every* translate, critique, and finalize call. This is the cheapest fix for the two mid-tier failure modes on books — terminology drift and tonal drift. (TransAgents prep stage; DelTA memory.)

### 4.4 Distill a frontier model offline into the prompt
Use a frontier model **once** to write the style guide and **3–5 gold source→target paragraph exemplars** in the exact target register; inject those few-shot exemplars into every Flash call. **Few-shot is the strongest empirical fix for language confusion** (Command-R cross-lingual line pass rate **1.1% → 95% with 5-shot**, arXiv:2406.20052). It is a *plausible* mitigation for over-literalness, but note: LITEVAL establishes the over-literalness *problem* and found complex prompts gave no substantial improvement — it does not validate few-shot as the *cure*.

### 4.5 Error-typed Estimate → targeted Refine, capped at 1–2 iterations
Per TEaR (§2.3): emit located, class-labeled error spans (untranslated / mistranslation / omission / awkward) and fix **only** those spans. **Accept a refined chunk only if its QE score improves**, else revert (neutralizes self-bias amplification and over-editing). Cap at 1–2 rounds. Log self-estimated vs QE-estimated quality to detect the self-bias signature (self-rating up while QE flat/down).

### 4.6 Ground refinement externally, not in pure self-critique
Drive repair from QE/back-translation signals (DUAL-REFLECT round-trip; xCOMET-QE spans), not free self-criticism, which a mid-tier model will hallucinate and self-bias toward (§2.4). Consider an **asymmetric setup**: Flash drafts/applies edits (bulk of tokens), a stronger model or QE metric produces the error annotations on a subset of chunks — breaking the same-model self-bias loop cheaply.

### 4.7 Multi-role passes, reserved for hard chunks
Run distinct prompted personas on the same model — Translator → Localization (idioms, honorifics, units, names) → Proofreader (fluency, register) — with **narrow remits** so the proofreader doesn't silently rewrite content. Reserve the full multi-role + best-of-N + DRT-style deep-reasoning path for **flagged hard spans** (detected wordplay, idioms, poetry, dialogue-heavy passages); use the cheaper single reflection loop elsewhere. Give hard spans Delabastita's explicit strategy menu with license to compensate (§1.5).

### 4.8 Cross-chunk consistency memory + omission guard
Carry the rolling summary + locked glossary forward; filter glossary to only entries present in the current chunk (DelTA-style). Add an explicit **omission/over-translation guard** at chunk boundaries: align source and draft segments and flag null alignments (under-translation) or hallucinated additions (over-translation) — strongest where long chunks spike repetition/omission.

### 4.9 Decoding hygiene
- **Finalize/fix passes:** low temperature (~0.3) or greedy — cuts language confusion (word-level pass rate 86.5% → 96.3%).
- **Candidate generation:** moderate temperature / nucleus (T~0.6, p~0.9) for diversity.
- Set `repetition_penalty` / `no_repeat_ngram_size` where exposed; otherwise detect n-gram loops and regenerate (neural text degeneration, Holtzman et al., arXiv:1904.09751).

### 4.10 Keep prose generation free-form; isolate JSON
Forcing JSON output **degrades quality** on small models (*Let Me Speak Freely?*, arXiv:2408.02442). Translate in free-form prose, then extract structure in a **separate** cheap call or via provider-native constrained/function-call output; guard every parse with a repair-retry.

### 4.11 Quality-gated escalation
Use the QE score (+ back-translation divergence) as a router: chunks below threshold after best-of-N + one repair loop **escalate to a frontier model.** Flash handles the easy ~90%; frontier budget is spent only on the hard tail.

---

## Cross-cutting design rules (the load-bearing summary)

1. **Paragraph/scene chunking, never sentence, never whole chapter.** Effective window ≪ max context.
2. **A persistent book bible (glossary + style sheet + rolling bilingual summary + voice cards) injected into every call** — the cheapest fix for drift.
3. **Decompose the human workflow into single-objective passes** (draft → comparative accuracy/omission → monolingual fluency/voice → proofread), translator-brain separated from editor-brain.
4. **Best-of-N + reference-free QE selection** is the single biggest mid-tier quality lever.
5. **Ground every refinement in an external signal; cap at 1–2 iterations; accept only if QE improves.**
6. **Gate correctness with QE/GEMBA-MQM (drop Locale); gate *literary* quality with a LiTransProQA-style QA judge** — never with BLEU/COMET alone, which reward translationese.
7. **Terminology: translate-then-revise + post-hoc check**, not prompt-promises or constrained decoding.
8. **Omission is the catastrophic class** — dedicate a completeness/back-translation guard at every seam.
