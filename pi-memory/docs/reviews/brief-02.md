# Review checkpoint 2: targeted fixes and experiment validity

Continue as the same read-only reviewer, Fable/high. Please keep this checkpoint bounded: review the changes addressing your findings and the two disputed oracle corrections, not the entire repository again. Print the review in conversation; do not edit files. Workers remain active. Do not read large raw event streams in full; use bounded relevant sections and summaries.

Your review1 is saved in docs/reviews/review-01.md. Current dispositions:

1. Capture worker fixed salience for corrections/replacements/updates and changed temporal classification from whole-entry to candidate-specific evidence clauses. Exact frozen ingestion/migration corrections now save/supersede durable knowledge despite an unrelated temporary remark. See src/capture.ts and added test/capture.test.ts cases, including forged source excerpts.
2. Dedicated test/dream-live.mjs now actually compares originals, stored lossless parents, genuine model-written hypotheses, and originals+parents (32 model runs). Automatic semantic hypothesis application remains disabled. Parent/original co-injection is measured and source retention is intentional, not a claim of shrinking total disk storage. A further representation-selection policy has not been adopted without action evidence.
3. Root is adding a separate real-clock fresh-session pre/post-expiry action test with capture enabled and no expiry hint in the test prompt. The longitudinal recent-window control remains a different memory-horizon concept and will be labeled separately.
4. Dream work moved out of capture into src/scheduler.ts: 30-second idle delay; cancellation on input, compaction, switch and shutdown; durable five-minute attempt backoff written before inference; no automatic print/JSON dreaming; explicit /memory dream still awaited. New sessions no longer count initial timestamp zero as 24h overdue. src/scheduler.ts tests cover cancellation, restart backoff and late callbacks after disposal. Root byte trigger uses actual serialized canonical project items; dream worker is aligning its byte report.
5. Longitudinal smoke showed the24 whole-job request cap dominated completion. Before final runs the worker is changing to600s whole-job and16requests per stage, with budget exhaustion separately reported. Old runs remain diagnostic.
6. Longitudinal worker is adding extension-loaded/empty-store controls and absolute cached/uncached counts; context allowances and differing information content will be explicit.
7. Longitudinal worker is tying action checks to exact CLI/tool output and adding wrong-project artifact controls. Node test subprocess restriction was fixed with test-isolation=none in the smoke.
8. Store growth now directly tests most-recent100/1000 active caps: four of six old gold facts disappear, recall0.333; no-cap recall1.0. One100k point costs~1.08s interactive storage,321MB. Same-scope precision remains0.286. Ratio and gap cutoffs were rejected after composed-query counterexamples. Polluted-store action ablation is being added separately.

Please independently check:

- Are capture temporal clauses/provenance now correct enough to run actual history ingestion, or is a concrete blocker left?
- Does scheduler cancellation/backoff avoid long blocking on compaction/shutdown and repeated paid aborted attempts? Identify any concrete lifecycle races from the new code.
- Audit the two proposed dream oracle corrections from the frozen source wording. Original gold demanded Beacon preflight=true even though the source only requires migrations, and Zephyr local preflight=null even though its source requires preflight for every deployment. The worker will save original and provisional rescored metrics separately and cite the source. Decide whether each correction is warranted, ambiguous, or invalid; do not accept it because all model arms agree. See test/dream-live.mjs and its results directory as linked in docs/DREAMING.md (if still being written, inspect the runner's output path and source fixture definitions only).
- What remaining evidence is essential before we claim the expanded user request complete? Distinguish implementation blockers from known limits; cap at six findings.

The full paid longitudinal matrix is not claimed complete yet. A final checkpoint will review finished results and claims.
