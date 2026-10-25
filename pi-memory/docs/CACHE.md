# Prompt and transcript stability

Memory uses `before_agent_start` to append a persisted `pi-memory/recall` custom message. It never registers `context` or `context_with_system` rewrites, removes earlier recall, or changes active tools during a session. The memory prompt section is computed from standing context at session initialization and remains stable until reload/session change.

Recalled IDs are reconstructed from the active branch; compaction resets the exclusion set, so knowledge omitted by the compactor can be recalled again. Tree navigation reconstructs the set for that branch. Input references expand into the user's message before the run.

Background capture uses a separate worker session key and retained prefix; optional retrieval selection uses a fresh key and no cache retention. A compaction or a change made by another extension may invalidate provider caching; memory makes no cache-hit guarantee in those cases.

`test/cache-live.mjs` runs two sequential prompts through the installed Pi binary with `openai/gpt-6.1-sol`, captures actual provider payloads, and checks that the second request starts with the complete first request input, with identical tools and leading instructions. It exercises both injection and combined modes. Artifacts are written under `eval/results/cache-live/` by default. Unit integration tests separately cover compaction and tree exclusion resets.

The final integration recheck is in [cache-live-timestamp](../eval/results/cache-live-timestamp/). Both two-request sessions preserved input prefix, declarations and system instructions, including a short-term memory carrying its actual retrieval timestamp. The combined-mode run declared all six memory tools; the injection-mode run used recall without directly declared memory tools. Declarations can appear in provider `additional_tools` input records, so the harness counts those as well as top-level tools.
