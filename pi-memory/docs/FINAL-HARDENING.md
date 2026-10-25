# Final integration and verification

The frozen action and size experiments completed before the final capture reliability changes were applied. Their source snapshot remains unchanged in the result directories. The follow-up changes affect capture and its result reporting; action-session capture was disabled in those experiments. Their scores are not presented as reruns of the final source.

## Applied fixes

- Invalid curator operations reject their candidate while valid siblings can commit. Completed malformed output is diagnosed and checkpointed, preventing an indefinite paid retry loop. Transport errors and cancellation retain pending evidence.
- Independent adjacent facts beginning with `Until ...` no longer give an unrelated durable fact a temporary lifetime. Bare expiry qualifiers remain attached to their supporting fact.
- Corrections preserve untouched portions of a bundled record. If the curator proposes an invalid edit span, one additional repair call is allowed for the whole capture pass. Candidate, action and target remain fixed, and all provenance, scope and lifetime guards are checked again. A failed repair does not trigger another automatic attempt on later turns.
- Actual invalid-output rejections produce a visible notice. Expected skips, such as an ungrounded temporary remark or already-documented fact, stay quiet. Resumed capture contributes saved counts and rejection diagnostics to tracing, notices and maintenance.

The final correction fix was prompted by a real failed live run: a semicolon-containing command record received an overbroad edit, which was rejected and left the old command active. That [failed run](../eval/results/capture-release/summary.json) remains available. Diagnostic probe provenance distinguishes an excluded stdin-contaminated probe from an exact-prompt probe; the latter demonstrated model variability rather than proving the original defect fixed. The new deterministic tests exercise a broad proposed edit and the finite repair path.

## Final-source proof

The [final seven-session live capture run](../eval/results/capture-repair-release/summary.json) passed with installed Pi 1.4.0 and `openai/gpt-6.1-sol`. It verified automatic learning, fresh recall, command correction and supersession, an unavailable capture model leaving pending evidence, later recovery with the original session/entry provenance, and fresh recall of the recovered fact. The real correction changed only the command literal; the surrounding clause survived unchanged.

The tested isolated runtime was compared byte-for-byte with the reviewed patch before application. Every runtime source then matched the working tree after application. [Application record and hashes](reviews/capture-hardening-applied.json) · [Prepared patch and verification](reviews/capture-hardening-results.json).

The hardening snapshot also passed the separate [real-clock retention run](../eval/results/retention-release/summary.json): eight sessions, actual pre/post-expiry file actions, and stable source hashes. That run preceded only the additional bounded edit-repair change; the temporal classification and retrieval implementation stayed unchanged afterward.

After integration, the complete workspace type checks and tests passed. The pi-memory suite contains **126 TypeScript tests and 5 evaluator tests, all passing**. Package builds, all 10 workspace package-content checks, publication dry-run, and diff whitespace checks passed. No package was published, committed, or installed globally.

The [final packed-extension smoke test](../eval/results/packed-handoff/result.json) also loaded the npm tarball outside the workspace without workspace `node_modules` and recalled the expected command through installed Pi. Its artifact records the package integrity and included files.

Claude Code `fable` with high effort reviewed the plan and successive fixes in the persistent `pi-memory-fable-review` tmux session. [Reviews 1](reviews/review-01.md), [2](reviews/review-02.md), [3](reviews/review-03.md), and [4](reviews/review-04.md) are retained. The last bounded repair addition also received a separate read-only review of its call cap, fixed target/action, repeated authority checks, sibling preservation and transport-failure behavior.

## Limits

Model extraction can still omit or reject a fact. Completed invalid output is not automatically retried indefinitely; the original conversation is retained and actual rejection is reported. Semantic hypotheses remain unreviewed, and retrieval can still omit a useful policy under a focused query or select redundant evidence. The reported gains apply to the documented synthetic tasks and do not establish universal memory quality or cost savings.
