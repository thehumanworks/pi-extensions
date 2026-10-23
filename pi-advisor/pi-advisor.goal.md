# Objective and outcomes

Improve `/home/nixos/pi-extensions/pi-advisor.ts` so agents proactively seek independent, evidence-based advice at consequential decisions, with private context-adaptive reminders during extended work. Preserve normal task execution and evaluate whether the added consultations justify their cost; do not claim behavioral improvement from deterministic tests alone.

# Context and inputs

The extension currently supports advisor configuration, `/advisor`, TUI status, and a text-only `ask_advisor` call through Pi's authenticated model registry. It does not add main-agent system guidance or reminders. Existing tests and documentation are `pi-advisor.test.ts` and `pi-advisor.md`.

The user explicitly wants context usage to increase reminder frequency without telling the agent its context usage or available capacity. Absolute length, percentage used, and growth since consultation are relevant private signals. Exact thresholds and implementation details are delegated engineering choices, not scientifically established optima.

Research inputs: https://arxiv.org/html/2505.06120 (early assumptions in multi-turn tasks); https://www.trychroma.com/research/context-rot (length-sensitive performance); https://arxiv.org/html/2310.13548 (sycophancy); https://arxiv.org/abs/2508.17536 (independent aggregation versus debate); https://arxiv.org/html/2607.06065v1 (repository-grounded review); https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices (premature stopping guidance). These motivate the design but do not validate its cadence or guarantee gains.

# Requirements and priorities

1. Add main-agent guidance when a usable advisor is configured. Recommend consultation before consequential plans/branches, narrowing ideas, building on unverified assumptions, reacting to contradictory evidence or repeated unsuccessful attempts, major phase/integration boundaries, and reviewing substantial changes/completion evidence. Do not require consultation for routine mechanical work or unchanged decisions.
2. Improve the advisor briefing/output instructions: separate observations from hypotheses, avoid leading diagnoses, examine actual plans/patches, identify evidence-backed concerns and missing information, suggest counterexamples or decisive checks, allow no material concern, and verify advice rather than pursuing agreement. Preserve the text-only, no-tools boundary and existing parameter compatibility.
3. Implement configurable fallback reminder scheduling whose frequency increases with absolute context length or utilization; also account for elapsed tool-bearing turns and additional context since consultation. Use conservative, documented experimental defaults and a cooldown. All model-visible guidance/reminders must be budget-neutral: no context measurements, capacity warnings, urgency, or premature-conclusion cues.
4. Suppress redundant reminders after a successful consultation. Handle failures, parallel/in-flight calls, disabled/unavailable advisors, cancellation, pending user input, session/branch changes, reload, model changes, and unknown/reduced usage around compaction. Never auto-call the advisor, force continuation, alter the main model, or expose private scheduling data in tool content.
5. Preserve existing configuration precedence, commands, safe settings persistence, status, headless operation, cancellation, and usage accounting. Do not modify unrelated extensions or personal installed copies.
6. Provide evaluation modes for current-style baseline, guidance only, fixed reminders, and adaptive reminders. Supply a practical comparison protocol measuring correctness, harmful advice, rework, cost/latency, and premature stopping on matched tasks. Distinguish implementation verification from a future behavioral trial; do not launch an unbounded paid benchmark.

# Acceptance and evidence

- Prompt tests demonstrate the required consultation and independence guidance, enabled/disabled behavior, and preservation of other extensions' structured/forced prompts.
- Scheduler tests demonstrate earlier reminders at greater absolute length and utilization independently, growth and turn triggers, bounded cadence, successful-consultation suppression, and lifecycle/error/cancellation handling.
- Inspect actual model-facing payloads in an offline Pi integration test: guidance and reminders arrive on ordinary requests without scheduling measurements or forced extra turns; existing tool calls and usage still work.
- Run existing advisor regressions, relevant neighboring tests, and strict TypeScript checking. Report exact commands and outcomes, including failures or checks not run.
- Document configuration/defaults, privacy and text-only limits, research caveats, and a reproducible evaluation protocol with retention criteria. Do not substitute call counts or agreement for task-quality evidence.

# Working guidance

Inspect the current Pi documentation, types, and lifecycle before implementation. Seek an advisor review at the design checkpoint and after coherent implementation. Keep changes scoped to advisor source, tests, and supporting goal/evaluation documentation. Prefer small testable scheduling logic and avoid new runtime dependencies. Preserve external/user edits. Stop when acceptance checks pass and remaining limitations are documented; report blockers honestly.

# Delivery

Deliver the updated extension, regression/integration tests, this reusable goal prompt, usage documentation, and evaluation instructions. Give a concise completion summary with evidence and distinguish implemented behavior from unmeasured real-world benefits.
