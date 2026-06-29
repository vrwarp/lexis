# Worked example: *Ender's Game* ch. 7 on a Flash-class proxy

These are the actual outputs of an end-to-end pipeline run (workhorse = `sonnet` as a weaker-than-Flash proxy; judge = `opus`). See [`../../../BENCHMARK_CH7_FLASHPROXY.md`](../../../BENCHMARK_CH7_FLASHPROXY.md) for the full write-up.

| File | What it shows |
| :--- | :--- |
| `ch7_v1_final.zh-TW.txt` | Pipeline output **before** the integrity/consistency hardening. Contains the failure modes the run exposed — a **leaked English agent-reasoning line** in the body (search `I have all the source material`) and **Bonzo** transliterated as both `波佐` (transfer slip) and `班佐` (body). |
| `ch7_v2_final.zh-TW.txt` | Output **after** the improvement pass. **Zero** English leakage; Petra normalized. (It also surfaced a *new* name regression — Valentine `瓦倫丁`/`瓦倫婷`, Salamander `蠑螈隊` — which is exactly why the durable fix moves name-locking into glossary **data** + a deterministic variant gate rather than a prompt instruction.) |
| `language_profile.generated.md` | The `language-profiler` output for en→zh-TW from this run. |
| `positive_constraints.generated.md` | The locked domain terms (`desk → 電子桌`, `toon → 分隊`, `battleroom → 戰鬥室`, `nullo → 零重`, …) the `glossary-manager` produced. |

These are illustrative artifacts, not a gold reference — v2 still has known issues (the documented name regression). They exist to make the benchmark's claims concrete and reproducible.
