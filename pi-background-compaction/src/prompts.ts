/** Instructions for one summarizer. `update` merges new messages into a previous summary. */
export interface PromptSet {
	system: string;
	initial: string;
	update: string;
	/** Appended after the native transcript when the request reuses the conversation's prompt cache. */
	transcript: string;
}

// Pi 1.4.0's built-in compaction prompts, kept verbatim as the baseline.
const PI_SYSTEM = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const PI_FORMAT = `## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const PI_INITIAL = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

${PI_FORMAT}`;

const PI_UPDATE = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TRANSCRIPT_LEAD = `Context checkpoint. Stop working on the task: do not call tools and do not answer the user. The conversation above will be replaced by your summary, followed by its most recent messages kept verbatim. Write the summary of the whole conversation so far, including anything still relevant from an earlier summary in it.`;

export const PI_PROMPTS: PromptSet = {
	system: PI_SYSTEM,
	initial: PI_INITIAL,
	update: PI_UPDATE,
	transcript: `${TRANSCRIPT_LEAD}\n\nUse this EXACT format:\n\n${PI_FORMAT}`,
};

const CODING_SYSTEM = `You write context checkpoints for a coding agent. The agent's older conversation is about to be deleted and replaced by your checkpoint; the most recent messages stay verbatim after it. The agent will continue the same work from your checkpoint alone, so anything you omit is lost.

You only write the checkpoint. Do not continue the conversation, answer questions in it, or call tools.`;

const CODING_FORMAT = `## Objective
[What the user wants, in their terms. List every task if there are several, and say which is current.]

## User Requirements
- [Every instruction, constraint, preference, and correction the user gave, with exact values: names, numbers, flags, versions, ports, formats, wording. Quote the user when wording matters. Note when a later instruction replaced an earlier one, and keep only the current rule.]

## Decisions
- **[Decision]**: [Why, and what was rejected]

## Work Completed
- [Changes made, by file path, with the functions, types, or settings involved]
- [Commands and checks run, with results: tests passing or failing, exact error messages]

## Current State
- [What is in progress right now, what was being tried when the conversation was cut, and anything left half done]

## Next Steps
1. [What to do next, in order]

## Reference
- [Facts the agent must not have to rediscover: file paths and their roles, identifiers, commands, URLs, IDs, configuration values, data shapes, error text]

Write terse bullet points. Copy identifiers, paths, values, and error messages exactly. Omit pleasantries, tool chatter, and exploration that led nowhere unless it rules something out.`;

const CODING_INITIAL = `The conversation above is the older part of a coding session. Write its context checkpoint.

Use this format:

${CODING_FORMAT}`;

const CODING_UPDATE = `The conversation above continues the session summarized in <previous-summary>. Write one checkpoint covering both: keep every requirement, decision, path, and value from the previous summary unless the new messages changed or retired it, add what the new messages contribute, and update Work Completed, Current State, and Next Steps to match where the work now stands.

Use this format:

${CODING_FORMAT}`;

export const CODING_PROMPTS: PromptSet = {
	system: CODING_SYSTEM,
	initial: CODING_INITIAL,
	update: CODING_UPDATE,
	transcript: `${TRANSCRIPT_LEAD}\n\nUse this format:\n\n${CODING_FORMAT}`,
};

export const PRESETS: Record<string, PromptSet> = { pi: PI_PROMPTS, coding: CODING_PROMPTS };
