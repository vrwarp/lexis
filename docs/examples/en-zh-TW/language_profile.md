# Language Profile — en → zh-TW (worked example / fixture)

> This is the **worked example** of the file `language-profiler` produces at init.
> It is NOT the pipeline's spec — every other language pair gets its own profile.
> Use it as a template and to regression-test that en→zh-TW behavior is unchanged.

## Script Relationship
- source_script: Latin
- target_script: Han (Traditional)
- relationship: DIFFERENT

## Sentence & Paragraph
- target_sentence_terminators: 。！？…
- source_sentence_terminators: . ! ?
- sentence_count_reliable: yes

## Dialogue Convention
- target_dialogue_open: 「  (also accepts “ )
- target_dialogue_close: 」  (also accepts ” )
- dialogue_count_unit: turn

## Register System
- system: lexical/pragmatic; no grammatical T–V or honorific tiers, but a strong casual↔formal axis carried by colloquial particles and word choice
- formality_tiers: 2 (casual / neutral)
- colloquial_markers: 啦 喔 嘛 吧 欸 哦 呢 囉

## Negation
- negation_markers: 不 沒 別 未 (source: not n't never no)

## Calque / Interference Patterns (en → zh-TW)
- sentence-initial heavy connective 然而/因此 → 但/可是/所以
- adverb-embedded reporting verb 大聲喊道/輕聲說道 → bare 說/問/吼/低聲說
- nominalized causation 他的憤怒讓他… → 他氣得…
- chains of 3+ verbs all closed with 了 → break at a clause boundary
- invented attribution on rapid unattributed exchange → keep bare exchange

## Check Applicability
- stray_source_detection: script_scan  (Latin chars in a Han draft)
- register_marker_gate: apply  (colloquial particles exist)
- negation_parity: apply
- sentence_count: apply ; dialogue_count: apply
