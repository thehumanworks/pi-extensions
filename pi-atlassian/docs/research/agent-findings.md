# Atlassian research journeys: architecture recommendation

## Recommendation at a glance

Build the integration as a small, composable research surface rather than a large list of REST-shaped tools.
Expose one direct discovery gateway for initial orientation, then make deeper Jira and Confluence operations callable through Pi codemode and discoverable on demand.
Return typed, bounded previews with durable-in-session handles; preserve every fetched byte in an exact local materialization that can be read back by explicit page or range.
Never imply a preview, outline, or summary is the entire source. A user/model journey should be able to go from project/space discovery to a cited section, full source, related context, and only then an explicitly authorized edit.

## Pi integration shape

- Implement as a trusted Pi extension, not a package for this task. Pi extensions execute with host permissions; review/limit filesystem and network access as carefully as credentials.
- Use the actual extension entry contract demonstrated in [hello.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/hello.ts): default factory receiving `ExtensionAPI`, `pi.registerTool`, TypeBox parameters, `execute()` returning `content` and `details`.
- Follow [Extensions: tools and exposure](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#custom-tools). Declare `outputSchema` and matching `structuredContent` for results intended as data; keep concise model-facing `content` too. Codemode callers get structured data rather than text.
- Use supported Pi imports only: docs and examples show `ExtensionAPI` from `@earendil-works/pi-coding-agent`, `Type` in [hello.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/hello.ts) from `@earendil-works/pi-ai`, and `Type` in [dynamic-tools.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/dynamic-tools.ts) / [truncated-tool.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/truncated-tool.ts) from `typebox`. Align concrete imports with the repository's eventual build setup; do not invent type names.
- Register tools first. Keep broad/deep operations `codemode` or `deferred`; use `namespace` with a short description and longer usage instructions. Pi documents that `codemode` tools are callable but not directly declared, while `deferred` tools are omitted from codemode listings and activated through `tool_search`.
- Keep a single direct `atlassian_discover`-style gateway for “what can I search/read here?” It should describe available products, configured tenant aliases (not secrets), discovery operations, and a few example journeys; it should not return all resources or credentials.
- Expose finer operations such as project/space lookup, search, issue/page read, hierarchy, comments, and edit as namespaced callable tools. Keep read and write namespaces distinct in descriptions and schemas.
- A codemode script can combine these calls, parallelize independent reads, filter large result sets, and return only selected evidence. See [Codemode: scripts and tool discovery](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md#scripts) and [Call tools](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md#call-tools).
- Use `searchTools`, `describeTool`, `describeNamespace`, and `ALL_TOOLS` rather than assuming the model already knows optional operation names. Keep codemode descriptions within their documented inline declaration budget.
- Tool schemas should force precise scope: product, tenant alias, project/space key or ID, search query, result limit, cursor, selected resource ID, representation, and explicit mutation intent where applicable.
- Set truthful annotations: reads as `readOnlyHint: true`; edits as destructive/non-read-only. Annotations are hints, not enforcement; an independent permission/confirmation policy must gate writes.

## Data and completeness contract

- Every search/list response is one bounded page. Return `items`, `limit`, `nextCursor` (or `null`), `hasMore`, total if authoritative, source link, and selected fields. Never silently stop after a page.
- Put hard server-side upper bounds on page size and response bytes; reject or clamp invalid values with a clear reported effective limit. Allow explicit follow-up pages rather than unbounded “fetch all”.
- Keep a stable handle for each fetched response/source: opaque, unguessable, scoped to the active Pi session and tenant, tied to product/resource ID, representation and version/ETag where available. Do not use array offsets or titles as identity.
- Materialize the exact response representation locally before producing a shortened preview. Store bytes/text plus metadata (source URL, retrieval time, content type/representation, resource/version ID, byte length and digest). Do not normalize, summarize, or rewrite the canonical materialization.
- Return handle, digest, length, representation, truncation status, and a clear read-back tool name whenever output is bounded. A full result must be recoverable with a handle plus explicit byte/character ranges or page/section selection; include offsets and total length in read responses.
- A materialization read API should accept a handle and validated range, return exact bytes/text and `start`, `endExclusive`, `totalLength`, and `complete`; bounded range sizes prevent context floods. Provide `read all` only through deliberate pagination, never implicit output expansion.
- Keep summaries/outlines separate from source material and label them as derived. Provide citations at item/section granularity: stable resource ID, title, canonical URL, version, and exact range/heading when known.
- Search snippets are discovery aids, not evidence of complete content. Preserve the raw page/search response so later pages and exact records can be recovered.
- A truncated result is a successful but incomplete result only if metadata makes the omission unmistakable and exact continuation is possible. Follow the explicit local-file fallback principle shown in [truncated-tool.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/truncated-tool.ts), but improve on its temp-path approach with opaque handles and range reads; never expose an arbitrary host path as the retrieval API.
- In Pi, do not assume `details` are model-visible. Put the useful preview and recovery instruction in `content`, and machine-readable handle/page metadata in `structuredContent` when `outputSchema` is declared.

## Suggested composable tool contract

- `discover(scope, query, limit, cursor)` returns tenant/product, matching projects or spaces, stable IDs, links, and paging metadata; it does not select one implicitly.
- `search(scopeId, query, limit, cursor, fields?)` returns compact ordered hits and the exact continuation state. Store query/scope alongside cursor so callers cannot accidentally reuse a cursor under a different search.
- `read_resource(resourceId, representation, fields?)` fetches one selected issue/page and materializes its full exact fetched representation before returning an abbreviated preview.
- `read_materialization(handle, range)` reads exact local content only; it makes no network request and cannot resolve arbitrary local paths.
- `read_relations(resourceId, relationKinds, limit, cursor)` returns typed edges and separate cursors per relation where upstream APIs paginate independently.
- `read_comments(resourceId, limit, cursor)` is separate from the resource body and records thread/anchor metadata when the API supplies it.
- `propose_edit(resourceId, target, patch)` should be a proposal/validation step only; a separate confirmed `apply_edit` performs the mutation after re-read and version check.
- All result schemas should distinguish `complete`, `hasMore`, `truncated`, `sourceVersion`, `handle`, and `warnings`; do not overload one boolean to mean page-complete and source-complete.
- For failed upstream requests, return a safe typed error category and any verified partial page metadata; omit response headers, request auth and raw stack details.
- Keep model-facing preview sizing independent from network page size and local materialization size. One must never imply the other is complete.

## Journey model

1. **Find project or space.** Discover available Jira projects or Confluence spaces, return bounded matching candidates with stable IDs/keys, names, URLs and paging. Ask for selection if ambiguous; do not guess based only on a similar title.
2. **Search.** Search within the selected scope, show compact ranked results and why they matched, and return page cursor plus exact source IDs. Jira uses JQL search; Confluence page discovery can filter by space/title. Keep the query and effective scope in the result for reproducibility.
3. **Select.** Resolve the chosen result by ID and revalidate it under the same tenant/account context. Store a stable handle, not an implicit “current item”.
4. **Outline and relationships.** Fetch only bounded metadata: parent/children, ancestors, issue links, project/space, labels, versions, and related pages/issues. Return relationship direction/type and separate partial relationship lists from complete ones.
5. **Choose specific section.** For Confluence, return headings/section boundaries derived from the fetched representation, with exact offsets into the original materialization. For Jira, choose a field/comment/worklog/link explicitly; field selection avoids dumping large custom fields.
6. **Read exact content.** Get the requested section or explicit source ranges, then offer subsequent ranges until the declared total is covered. Show representation (e.g. storage/editor or rendered view) because transformed text is not byte-identical to the original.
7. **Comments and context.** Fetch comments and relevant issue/page relationships as distinct bounded streams, paginate independently, and retain author/time/parent or anchor data. Cross-reference each item with source IDs and links.
8. **Safe edit.** First read the current version and exact target, show a proposed patch and expected affected fields, and obtain user confirmation. Require explicit target ID, edit operation and concurrency/version precondition; report the resulting version and reread/verify it. Never let a research summary silently become a write payload.

## API mapping from the official indexes

The checked-in indexes are navigation references, not a second API specification: [Confluence v2 index](../confluence-v2-index.md) and [Jira v3 index](../jira-v3-index.md). Use their official group links for operation details; do not edit either index.
Resolve all discovery within the caller's authorized account; never offer an unauthenticated global catalog as though it were visible to the user.

- Jira project selection: [Projects](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/). Request only fields needed for identity and labels; use the documented project listing/search operation rather than enumerating unrelated administrative APIs.
- Jira issue search: [Issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/) and [JQL](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-jql/). Use scoped JQL and selected fields; follow the operation's paging contract, not assumptions about fixed offsets or total counts.
- Jira detail, links and comments: [Issues](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/), [Issue links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-links/), and [Issue comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/). Fetch comments and relationship data separately when possible to preserve independent pagination and completeness.
- Confluence scope and discovery: [Space](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space/) and [Page](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/). V2 list operations expose cursor/limit pagination; preserve and follow the returned next cursor/link with a configured bound.
- Confluence exact page, hierarchy and comments: [Content](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-content/), [Children](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-children/), [Ancestors](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-ancestors/), [Descendants](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-descendants/), and [Comment](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-comment/). Request a deliberate body format and do not claim a rendered/converted representation is the original source.
- Jira's official [REST v3 introduction](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/) covers authentication, permissions, pagination, special headers, asynchronous operations, and status codes. Confluence's [REST v2 introduction](https://developer.atlassian.com/cloud/confluence/rest/v2/intro/) covers authentication/authorization and REST use. Implement documented permission/status behavior and respect each product's actual continuation mechanism.

## Trust, cancellation, lifecycle, and isolation

- Treat all remote fields—including comments, titles, descriptions, links and returned error text—as untrusted data. Delimit/cite them; never interpret them as tool instructions or let retrieved content choose arbitrary endpoints, paths, or edit actions.
- Restrict requests to configured HTTPS Atlassian API origins and known API paths. Validate redirects and pagination URLs against the same origin/path allowlist before attaching credentials; do not forward auth headers across origins.
- Keep tenant identity and authorization context explicit on every call. Never let a handle from tenant A resolve under tenant B. Do not log bearer material or include it in tool output, exceptions, codemode state, or session entries.
- Use the active tool execution signal for HTTP calls, retry sleeps, page loops and local materialization. Pi states `ctx.signal` is for nested work owned by an active turn; propagate the execute signal where provided and stop promptly on cancellation.
- Bound network timeout, retries, concurrency, response size, page count and total materialized bytes. Retry only safe/idempotent reads for transient failures; honor rate limits and return retry context without hiding partial completion.
- Scope caches/materializations to session + tenant + user identity. Use opaque random IDs, restrictive permissions, no symlink-following, and atomic writes. On access, verify ownership and stored digest; never accept a user-supplied filesystem path.
- Keep branch-sensitive pointers in tool-result `details` or codemode's documented small JSON store, not process-global mutable “selected issue” state. Codemode store values are branch-aware but limited in size; use them for references, not document bodies.
- Start long-lived resources only from `session_start`/on demand; clean up idempotently in `session_shutdown`. Pi docs warn that the extension factory can run without a session and reload invalidates old runtime state.
- Avoid interactive-only assumptions. Keep tool behavior usable in TUI, RPC, JSON and print modes. For mutations, require a supported confirmation path or refuse when approval cannot be obtained; no UI must not mean implicit consent.

## Validation plan: prove completeness and boundaries

- **Pagination:** deterministic fixtures with 0, 1, limit, limit+1 and many pages; assert no duplicate/missing IDs, cursor propagation, final `hasMore=false`, and clear incomplete status at configured caps.
- **Exact recovery:** fixtures with long Unicode, CRLF, multibyte boundaries, empty data and large content; concatenate bounded range reads and compare byte-for-byte and digest to the original materialization.
- **Truncation truthfulness:** force previews over line/byte budgets; assert explicit omitted count, exact total length, stable handle, and successful read-back of omitted ranges. Assert no path-only “recovery”.
- **Changed resources:** simulate version/ETag changes between outline and edit; assert stale preconditions block writes and require a fresh read/confirmation.
- **Identity/isolation:** two tenants, users, sessions and branches; assert handles, caches, cursors and comments never cross boundaries. Reject forged, expired, malformed and cross-tenant handles without disclosing whether another tenant's object exists.
- **Path isolation:** fuzz traversal, encoded separators, absolute paths, symlinks, race replacement and malformed handle input; prove storage resolution remains under a private managed directory and no API response can choose a local path.
- **Network trust:** deny HTTP, unknown hosts, cross-origin redirects, and pagination links outside allowlist; test remote prompt-injection text is returned only as quoted/cited data and cannot trigger writes.
- **Cancellation/lifecycle:** abort during request, pagination, write and range-read; assert no later calls, partial results are labeled, temporary artifacts are cleaned, and shutdown/reload cleanup is idempotent.
- **Write safety:** assert read tools cannot mutate, write tools reject missing user approval and preconditions, and confirmation names the exact tenant/resource/field and proposed change.
- **Pi contract:** schema-validate every structured result; check concise `content` plus matching `structuredContent`, codemode discovery of deferred tools, nested-call cancellation, and no secret leakage in tool errors or renderers.

## Source note

Pi contracts above were read in full from the installed Pi 1.0.4 `docs/extensions.md`, `docs/packages.md`, and `docs/codemode.md`, and checked against the requested `hello.ts`, `dynamic-tools.ts`, and `truncated-tool.ts` examples. Pi docs note extensions have ordinary host permissions, codemode scripts have no direct filesystem/network access, tool calls are real (not rolled back on script failure), and nested calls propagate usage. API references link only to public official Atlassian documentation; no credentials or live tenants were accessed.
