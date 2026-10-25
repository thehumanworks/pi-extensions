# Longitudinal action benchmark proposal

Status: historical proposal for the extension to the completed frozen recall benchmark. The implemented tasks evolved to streaming ingestion/checkpoint recovery and versioned configuration migration. See [LONG-RUN-EVALUATION.md](../docs/LONG-RUN-EVALUATION.md) for the implemented protocol and measured results. This proposal is not itself evidence of completed runs. Its fixtures and results remain separate from `cases.json` and `stress-cases.json`.

## Question and observable outcome

Does retained experience change what a Pi agent actually does during a later, harder development task, while keeping memory size and model budgets bounded? A passing final explanation is insufficient: the modified repository must pass external executable acceptance checks, and the action trace must show the intended behavior.

Use two disjoint temporary repositories, each with a development variant and a held-out transfer variant. Give them overlapping vocabulary and different policies so scope mistakes produce observable wrong behavior. Never use real project sessions, credentials, customer data, or the user's repository as task input.

## Representative tasks

| Repository | Multi-step implementation task | Retained knowledge required | Executable acceptance |
| --- | --- | --- | --- |
| Dispatch queue | Implement a persistent job runner across storage, retry scheduling, and CLI modules; diagnose a deliberately failing fixture; preserve existing queued work. | Tenant-scoped idempotency, a verified recovery procedure, current retry policy replacing an older decision, and an operation-order constraint. | Run jobs for two tenants sharing an idempotency key; restart after an interrupted write; check retry boundaries with an injected clock; verify unrelated queued jobs survive. |
| Ledger importer | Implement an import pipeline across parsing, normalization, duplicate handling, and a CLI report; support malformed input and deterministic reruns. | Customer-specific column mapping, encoding and missing-value rules, an explicit correction to duplicate policy, and the prior lesson that local timezone conversion corrupts a date boundary. | Parse quoted/CRLF/Unicode inputs; verify repeated imports are idempotent; test the corrected duplicate rule and date boundaries; reject incomplete rows without silently deleting source data. |

Provide visible tests for generic mechanics. Keep policy-specific and transfer checks outside the model's workspace. Tests must exercise outputs and persisted state, not search source text for preferred strings. The held-out variants change filenames, identifiers, failure presentation, and input distributions while keeping the relevant general procedure valid.

## Fixed history and decision schedule

1. Establish a small set of explicit user decisions, including one future constraint not already implemented in the repository.
2. Run a real repair episode with an observed failure and a verified fix. Capture must derive the lesson from that trajectory.
3. Introduce several unrelated but plausible work episodes and other-project history.
4. Explicitly correct one earlier decision. Preserve the superseded evidence as historical data.
5. Start a fresh Pi session for the multi-file implementation task. Do not repeat the hidden decisions in its prompt.
6. Run an independently frozen transfer task that needs the general procedure, rather than the original incident's literal commands or values.

Keep every history episode, correction, task prompt, and expected acceptance condition frozen before tuning. Do not substitute hand-authored ideal memories for a failed automatic capture. Record capture failures as part of the system outcome.

## Arms and comparable budgets

| Arm | Available context |
| --- | --- |
| None | Current task and repository only. |
| Short term | A fixed recent-history window, without durable memory. |
| Long term | Actual captured persistent memory from the complete prior schedule, with the same bounded recent-history window. |
| Consolidated | A clone of the same captured store after the background consolidation/generalization pass. |

Use the same approved model, thinking level, task prompt, available development tools, output cap, and total turn ceiling. Count recent-history content and retrieved content against an explicit common context allowance; otherwise a larger prompt can masquerade as better memory. Record any irreducible difference between the short-context control and the real extension.

Use actual Pi `read`, `edit`, `write`, and test-execution tools inside temporary repositories. Every arm gets the same tool surface. Keep external acceptance tests inaccessible to the model until scoring. Instrument model requests to cap output per request and cap the total turns/usage per task; a timeout or exhausted budget is an incomplete task, not a discarded sample. Begin with two repeated runs of each arm and at most two concurrent Pi processes.

## Scores and artifacts

- Primary: task completion rate, requiring all critical external acceptance checks. Also report partial check coverage to explain failures.
- Action utility: whether the first relevant command uses the known recovery, whether edits apply the current policy, failed-test attempts before correction, wrong-project policy usage, and preservation of unrelated files/state.
- Retention and updating: useful facts retained after distracting episodes, old-policy behavior after a correction, and whether the transferred procedure succeeds on a novel failure presentation.
- Generalization: task outcome before and after consolidation on identical cloned stores; preserve source links so a generalized rule can be traced to actual episodes.
- Resource use: provider input/output/cached tokens, whole-run latency, injected context size, active canonical bytes, archived bytes, index bytes, journal/proposal bytes, and total extension-owned bytes. Report raw source-session storage separately rather than hiding it in a memory-size claim.
- Controls: unrelated memory, foreign-project lookalikes, missing approval, stale decisions, and instruction-shaped content from a tool result. Count both attempted improper actions and actual state changes.

Artifacts should include fixture/source hashes; all synthetic history and raw Pi event streams; before/after repository snapshots or diffs; executable test reports; exact selected memory IDs and provenance; store-size snapshots; consolidation inputs, outputs, and model usage; per-stage score/error records; and a paired aggregate.

## Ownership and sequencing

The coordinator owns the final protocol and interface decisions. The evaluation worker owns longitudinal fixtures, Pi execution, executable acceptance checks, action scoring, and result aggregation under `eval/longitudinal/`. The caching workstream owns actual provider cache measurements. The store workstream owns mixed-project scale and size-ceiling implementation/measurements. The capture workstream owns capture, consolidation, and generalization behavior. Their raw results feed the common report without overlapping source ownership.

Next integration decisions are the capture/history ingestion interface, the consolidation trigger and completion signal, what the persistent size ceiling includes, and the global model-call concurrency allocation. Freeze those contracts and one development job first; run a real tools-on smoke before multiplying the matrix. Only then freeze the transfer cases and run the complete paired experiment. The completed recall benchmark remains a separate result, not a substitute for this action-level evidence.
