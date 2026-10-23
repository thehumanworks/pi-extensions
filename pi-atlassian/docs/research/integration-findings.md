# Supervisor integration observations

Recorded during build v1-001; code agents may still be improving these. Recheck against final sources before treating a finding as current.

## Verified checks so far

- Strict npm run check passed.
- Real Pi1.0.4 extension loading via `pi --no-extensions --no-mcp --extension ./index.ts --help` passed without credentials.
- Current `npm test` ran 42 unit/extension tests, all passed. It explicitly enumerates only those two files; newly added `tests/transport.test.ts` is NOT yet included.
- Separate `node --import tsx --test tests/transport.test.ts` ran14:13pass,1fail. Last test `Confluence approved update re-reads version and then attempts one exact PUT` fails `id must be a nonempty string` at service plan's pageId=id(input.path.id), with a valid numeric OpenAPI path ID. Build() already serializes IDs from numbers; plan version-guard normalization must use the same convention. Do not remove/skip this valid success-path test; fix the service.

## Live configuration finding (values withheld)

- Supervisor executed `dotenvx run -- npm run test:e2e`. It failed **before network** because `ATLASSIAN_BASE_URL` is a bare enterprise hostname, not a URL with a scheme. Safe config-shape probes confirmed URL parsing=false and credentials-present=true; values were never printed. Support a validated configured bare hostname by normalizing it to HTTPS (never silently HTTP), preserving optional safe base paths. Do NOT edit .env or its secrets. Keep explicit HTTP rejection, userinfo/query/fragment rejection and traversal safeguards. Document bare-host shorthand and add an offline regression test.

## Secure enterprise TLS finding

- With the trusted configured hostname normalized to HTTPS in memory, live GET /myself initially failed TLS with the safe code `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (no values/certificate/host printed). Using Node's **system CA trust** (`NODE_USE_SYSTEM_CA=1`, `node --use-system-ca`) made the same public-service read PASS with the provided credentials. Do not disable TLS verification or add trust for an unverified server certificate.
- For this enterprise environment, make read-only E2E use system CA trust in its Node invocation (supported installed Node26.10), and document secure system CA / NODE_EXTRA_CA_CERTS options for Pi/Bun. Allow an explicit local CA bundle via standard runtime settings, not a model-controlled tool parameter. Surface permanent certificate failures as safe actionable TLS categories rather than three generic network retries.
- None of these probes edited .env, accessed secret file content, printed environment values, or ran a mutation. They used the public service plus wrapper, with config normalization only in process memory.

## Review hypotheses needing proof

- Live E2E currently uses unbounded JQL `ORDER BY updated DESC`; modern enhanced search can require a restriction. Use a selected project ID or a bounded updated date instead of relying on obsolete unbounded-query semantics. Do not turn genuine auth/network errors into skips. Tests must not log raw tenant diagnostics.
- Confluence may return `_links.next=/api/v2/...` relative to a `_links.base` ending in /wiki, instead of /wiki/api/v2/...; verify safe normalization of genuine links while keeping origin/cloud/operation-path validation. Never loosen to arbitrary relative authenticated endpoints.
- Jira unpaginated lists (fields, issueLinks, transitions, remoteLinks, attachments) can return more than requested limit. Current paged() projects every returned record and complete=true if no server continuation. Contract says bounded navigation. Use local immutable paging over one exact saved response if needed; do not drop records or repeatedly refetch the same array.
- Generic path params currently all use strict resource-ID regex. This can reject legitimate documented dotted property keys (e.g. app.property) or account IDs with colon. Separate verified path-segment encoding from page/issue ID validation; keep traversal, slash, backslash, percent-encoding, query and fragment guards. Add legitimate-key tests as well as invalid-path tests.
- Read outline is recoverable as a ranged serialized derived object, but emitted headings array is gated by a16000 text-size check; docs should explain exact outline ranges versus raw source offsets.
- Operation docs often fall back to intro. Improve generated docs links from existing saved group indexes/tags where available rather than inventing URLs, to make discovery actionable.

This file contains only local/mock/public-doc observations, no tenant content or credentials. Supervisor alone runs live smoke tests through dotenvx.

## Final integration evidence and corrected credential attribution

- Repair resolved numeric IDs, safe bare-host HTTPS normalization, genuine Confluence continuation paths, bounded lossless local/upstream paging, dotted/colon path keys and actionable permanent TLS errors. Strict check and104 offline tests passed; codemode activation added one regression and write controls added12, for117 passing offline tests.
- Actual Pi1.0.4 loads the extension and lists `--atlassian-allow-writes` in CLI help. CLI/TUI control semantics and concurrent revocation are mock-tested; actual native Pi read-only codemode smoke passed all five assertions with no skips (direct run003). Narrow CLI tool allowlists can hide the callable namespace: use runtime activation instead. Async codemode discovery helpers must be awaited. Smoke verdicts are now parsed by a deterministic gate; model process exit0 alone is not test success.
- Direct `dotenvx run -- npm run test:e2e` passed all five tests with no skips. **However this was NOT validation of the newly encrypted .env token:** safe subsequent comparisons established that the supervisor inherited an already-defined token, and dotenvx default precedence preserved it. No values or fingerprints were printed. Fresh `dotenvx run --overload -- ...` and isolated Dagu runs use a different decrypted token and receive **HTTP401**. Therefore .env-authoritative live verification remains **blocked by credentials/auth routing**, not passed; do not hide this as a skip or silently fall back to the inherited token. Update/verify the supplied token, account, scopes and required site/gateway auth configuration before rerunning.
- Dagu does not inherit arbitrary parent variables into steps. Experimental explicit captures proved a read could succeed using the inherited credentials, but those were intentionally removed from the final live workflows: authoritative dotenvx injection within the live-only step is the correct test boundary. Code/review agents receive no tenant credentials.
- The shared `/tmp` filesystem filled during validation (5.8G tmpfs). No unrelated data was deleted. A private ignored `.atlassian/tmp` on the workspace filesystem is used as explicit TMPDIR for workflows and final supervisor checks. The original write-controls run's post-agent test failure was ENOSPC; the correction workflow independently reran strict check and117 tests successfully there.
- Write-controls review found one documentation/fake-lifecycle mismatch: Pi recreates the extension runtime for session replacement. Targeted scope correction fixed docs/tests; tree navigation preserves only the current runtime override. Controls never edit environment/credentials, source handles survive toggling, OFF revokes plans/pending work, and enabling is not mutation approval. No live writes were performed.
