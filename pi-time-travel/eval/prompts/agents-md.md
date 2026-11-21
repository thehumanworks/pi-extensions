# AGENTS.md

Guidance for coding agents and new contributors working in our repositories. Read it before you change anything; most of it is about keeping the codebase consistent for the next person.

## Who we are

We are a small product team building a commerce platform: a public storefront, a merchant dashboard, a set of HTTP APIs, and the background jobs that keep orders, payments, and inventory in sync. Most services are TypeScript or modern JavaScript on Node.js, deployed as containers. Each repository has its own README with service-specific details; this file covers what is shared.

## Repository layout and ownership

- Monorepos keep deployable services in `apps/` or `packages/<service>` and shared libraries next to them. Look at the root `package.json` workspaces field to see what is a package.
- Every package has an owner listed in `CODEOWNERS`. Changes to a package you do not own need a review from its owners, so keep them small and explain them in the pull request.
- {{rule:stay-in-scope}}
- Generated files (`dist/`, `build/`, `coverage/`, `*.generated.ts`) are never edited by hand and never committed unless the package README says otherwise.
- Configuration lives in `config/` or in environment variables documented in `.env.example`. Never commit real secrets, tokens, or customer data, including in tests and fixtures.
- Scripts that developers run by hand go in `scripts/` with a comment at the top saying what they do and whether they are safe to re-run.

## Development setup

- Use the Node.js version in `.nvmrc` or the `engines` field. If they disagree, `engines` wins.
- Copy `.env.example` to `.env` for local development; the defaults talk to local containers started with `docker compose up`.
- The local database is seeded with `scripts/seed`. It is safe to drop and recreate it at any time.
- If something in the setup instructions is wrong or out of date, fix the instructions in the same pull request rather than working around them silently.

## Dependencies

- {{rule:use-pnpm}}
- Prefer the standard library and the dependencies a package already has. A new runtime dependency needs a reason in the pull request description: what it does, how big it is, and whether it is maintained.
- Pin exact versions for anything that touches money, authentication, or cryptography. Ranges are fine elsewhere.
- Do not add a dependency to the root package unless every workspace needs it; add it to the package that uses it.
- Renovate opens dependency update pull requests every Monday. Do not mix dependency updates into feature work.

## Code style

- Formatting is Prettier with the repository's config, and linting is ESLint. Both run in CI; a failing lint blocks the merge. Run the formatter on files you touch, not on the whole repository.
- Name things for what they are in the domain: `order`, `lineItem`, `refund`, not `data`, `obj`, or `item2`. Abbreviations only when they are universal (`id`, `url`, `http`).
- Functions should do one thing. If a function needs a comment to explain what its sections do, split it.
- Prefer early returns over nested conditionals.
- Keep modules small and cohesive. A file over about 400 lines is usually two files.
- Comments explain why, not what. Remove commented-out code instead of leaving it in.
- Use `const` by default, `let` when a binding changes, never `var`.

## TypeScript

- `strict` is on everywhere. Do not turn it off per file.
- Avoid `any`. Use `unknown` and narrow it, or write the type. If you must use `any`, leave a comment saying why.
- Model states with discriminated unions rather than optional flags that must be set together.
- Export types next to the functions that use them. Do not create a catch-all `types.ts`.
- Validate data at the boundary (HTTP input, queue messages, environment variables) with the schema library the package already uses, and trust the types inside.

## Error handling

- Throw `Error` subclasses with a clear message and, where useful, a `cause`. Never throw strings.
- Do not swallow errors. If you catch one, either handle it completely or rethrow it with context.
- HTTP handlers map known errors to status codes in one place (`errors.ts` in each API); everything else is a 500 that is logged with the request id.
- Retries belong in the job runner or HTTP client configuration, not in hand-written loops.

## Logging and observability

- Use the package's logger, never `console.log` in service code. Scripts and tests may use `console`.
- Log structured fields (`{ orderId, merchantId }`) rather than interpolating them into the message.
- Never log secrets, full card numbers, passwords, tokens, or personal data beyond ids.
- Every new endpoint and job gets a metric for count, error count, and duration, following the existing naming.

## Testing

- Tests use `node --test` unless a package README says otherwise. Run the tests of every package you change before you say you are done, and say which ones you ran.
- {{rule:no-test-edits}}
- Unit tests sit in `test/` next to `src/`, named after the module they cover. Integration tests that need containers live in `test/integration/` and are skipped unless `INTEGRATION=1` is set.
- Tests must be deterministic: no real network, no real clock where the result depends on it, no reliance on test order. Fake time with the test runner's mock timers.
- Prefer a few tests that exercise real behaviour over many tests of implementation details. Mock at the boundaries (HTTP, database, queue), not between our own modules.
- A bug fix comes with a test that fails before the fix and passes after it.

## Git workflow

- Name branches `<type>/<short-description>`, for example `fix/refund-rounding` or `feat/merchant-export`.
- Keep commits focused and write messages in the imperative mood: "Add refund export", not "Added" or "Adds". The first line is at most 72 characters; explain the why in the body when it is not obvious.
- Rebase your branch on `main` before asking for review, and squash fixup commits.
- {{rule:no-force-push}}
- Do not rewrite history on `main` or on tags, ever.

## Pull requests

- One logical change per pull request. If the description needs the word "also", consider splitting it.
- The description says what changed, why, how it was tested, and anything a reviewer should look at closely.
- Screenshots for UI changes, before and after.
- At least one approval from an owner of each package touched. Respond to every review comment, even if only to say "done".
- CI must be green before merging. Do not merge over a red build, even for "unrelated" failures; fix or quarantine the failing check first, with an issue linked.

## Security

- Treat all input as hostile: validate, encode output, use parameterised queries, never build shell commands from user input.
- Authentication and authorisation checks live in middleware, not in individual handlers. A new endpoint is private by default.
- Report suspected vulnerabilities privately to the security channel, not in a public issue or pull request.
- Secrets come from the secret manager at runtime. If you find a secret in the repository, rotate it first and then remove it.

## Performance

- Measure before optimising, and include the numbers in the pull request.
- Database queries in request paths must use an index; check the plan for anything new. No queries inside loops.
- Paginate every list endpoint. The default page size is 50 and the maximum is 200.
- Cache only with a clear invalidation story written next to the cache.

## Documentation

- Every package README covers what it is, how to run it, how to test it, and its configuration.
- Public functions in shared libraries have a doc comment with an example.
- Architectural decisions go in `docs/adr/` as short records: context, decision, consequences.
- Keep docs next to the code they describe and update them in the same pull request as the code.

## Releases

- Services deploy from `main` automatically after CI passes. Libraries are released with changesets: add one to any pull request that changes a published package.
- Feature flags guard anything risky. Remove the flag and the dead branch once the feature is fully rolled out.
- Hotfixes branch from the release tag, get a pull request like anything else, and are merged back to `main` the same day.

## Working as an agent

- Read the package README and the files you are about to change before changing them. Follow the patterns already there.
- Make the smallest change that solves the problem. Do not refactor unrelated code on the way.
- When an instruction here conflicts with the task, or you are unsure whether something is allowed, stop and ask rather than guessing.
- When you finish, summarise what you changed, which commands you ran, and anything you could not verify.
