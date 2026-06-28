## Script Relationship
- source_script: Latin
- target_script: Han (Traditional)
- relationship: DIFFERENT

## Sentence & Paragraph
- target_sentence_terminators: 。！？…
- source_sentence_terminators: . ! ?
- sentence_count_reliable: yes

## Dialogue Convention
- target_dialogue_open: 「
- target_dialogue_close: 」
- dialogue_count_unit: turn

## Register System
- system: lexical/pragmatic; no grammatical T–V or honorific tiers, but a strong casual↔formal axis carried by colloquial particles, word choice, and sentence-final particles distinctive to Taiwan Mandarin
- formality_tiers: 2 (casual / neutral-formal)
- colloquial_markers: 啦 喔 嘛 吧 欸 哦 呢 囉 耶 ㄟ

## Negation
- negation_markers: source: not / n't / never / no / neither / nor; target: 不 沒 別 未 從不 絕不

## Calque / Interference Patterns (en → zh-TW)

1. Sentence-initial heavy connective calqued from "However/Therefore/Nevertheless" → 然而/因此/儘管如此 — use 但/可是/不過/所以 or restructure as clause-initial topic.
2. Adverb-embedded reporting verb calqued from "he said quietly / she shouted" → 他輕聲說道/她大聲喊道 — use bare 說/問/吼/低聲說; the adverb inside the verb compound is translationese.
3. Subject-prominent sentence structure calqued from English SVO → 他的憤怒讓他無法思考 — in natural Mandarin prefer topic-comment: 氣得他腦子轉不過來.
4. Redundant pronoun chains: English repeats "he … he … he" across sentences; zh-TW naturally drops the subject after the first mention — preserve the dropped-subject pattern, do not re-insert 他/她 at every clause.
5. Chains of three or more verbs each individually closed with 了 → break at a natural clause boundary; only one perfective 了 per clause is idiomatic.
6. Invented or ornate dialogue attribution on rapid back-and-forth exchanges (Card deliberately strips attributions in fast dialogue) → keep bare exchange without 他說/她問; when an attribution is truly needed, use a plain verb, not a compound adverb-verb.

## Check Applicability
- stray_source_detection: script_scan (Latin chars in a Han draft)
- register_marker_gate: apply
- negation_parity: apply
- sentence_count: apply
- dialogue_count: apply