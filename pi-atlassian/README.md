# Atlassian for Pi

An agent-native Pi 1.0.4 extension for Jira Cloud V3 and Confluence Cloud V2, with the explicit V1 CQL search exception. It exposes **one direct discovery tool**, not hundreds of endpoint declarations. Search/list responses are navigation metadata; rich content stays recoverable through private, exact source handles.

## Setup

Requires Node ≥22.19 and Pi 1.0.4. Install development dependencies without lifecycle scripts:

```sh
npm install --ignore-scripts
npm run check
npm test
```

Provide credentials externally using dotenvx (this package does not open credential files). By default dotenvx preserves already-defined environment variables: use `--overload` when you need the `.env` file to be authoritative, especially when validating a newly encrypted token.

```sh
dotenvx run -- pi -e ./index.ts
```

Configure these exact environment variable names through your own secret manager/dotenvx setup:

| Variable | Meaning |
|---|---|
| `ATLASSIAN_BASE_URL` | Your configured HTTPS site/enterprise host (safe bare hostname shorthand such as `jira.example.com` is normalized to HTTPS in memory), optionally with a base path ending `/wiki`; or `https://api.atlassian.com` for gateway routing. Never supplied as a tool argument. |
| `ATLASSIAN_API_USERNAME` | Account email/username for basic auth. |
| `ATLASSIAN_API_TOKEN` | API token for basic auth, or access token for bearer auth. |
| `ATLASSIAN_AUTH_MODE` | `basic` (default) or `bearer`. Choose the mode appropriate to your token. |
| `ATLASSIAN_CLOUD_ID` | Required for the `api.atlassian.com` gateway; not a project/space ID. |
| `ATLASSIAN_ALLOW_WRITES` | `1` to authorize planned writes without additional UI approval; default disabled. Applies in TUI, RPC, print and JSON modes. |

Classic user API tokens normally use the site host and basic email:token auth. OAuth/scoped credentials may require gateway routing and the relevant scopes. Gateway requests use `/ex/jira/<cloudId>/rest/api/3/...` or `/ex/confluence/<cloudId>/wiki/api/v2/...`. HTTPS enterprise hosts are accepted, but Cloud APIs must actually be supported; this is not a Jira Server/Data Center compatibility layer. Insecure hosts are rejected. Localhost HTTP requires injected test fetch or the explicit `ATLASSIAN_ALLOW_INSECURE_LOCALHOST=1` test-only opt-in.

Missing credentials do not block extension loading, `--help`, discovery, schemas or local reads. Configuration is checked before the first network request. Authentication material is not included in status, previews or transport error messages. Do not ask the model to print tokens.

### Enterprise TLS trust

Certificate verification always remains enabled. `test:e2e` invokes Node with `--use-system-ca` to include trusted OS CAs. For Node-hosted Pi, set `NODE_USE_SYSTEM_CA=1` before starting the process when the enterprise issuer is already trusted by the OS. Alternatively, set `NODE_EXTRA_CA_CERTS=/absolute/path/to/trusted-ca-bundle.pem` at process startup to extend trust with an administrator-verified CA bundle. These standard runtime settings are not tool parameters; this extension does not load certificates itself.

For Bun-hosted Pi, use Bun's supported `NODE_EXTRA_CA_CERTS` setting with a trusted PEM CA bundle; `NODE_USE_SYSTEM_CA` and `--use-system-ca` are Node-specific, not portable Bun switches. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`, disable verification, or trust a certificate merely because a failing server presented it. Known permanent issuer/expiry/hostname certificate failures produce a safe TLS category and actionable trust guidance without network retries or raw certificate diagnostics.

### Codemode or direct activation

Start normally, with Pi's builtin codemode registered:

```sh
dotenvx run -- pi -e ./index.ts -e builtin:codemode
```

Ask the agent to call `atlassian_discover` with `kind:"tools", query:"codemode"` to enable only codemode, keeping the deeper namespace schemas undeclared. Alternatively enable `+codemode` in Pi's `defaultTools`.

Do not use a narrow CLI `--tools` allowlist containing only the gateway and codemode: it can remove deeper custom tools from the callable registry. If you deliberately use an allowlist, include `atlassian_*` (at the cost of explicit declarations). The persisted smoke workflow uses a session loadout hook instead, with only two active declarations. The eight deeper tools have `codemode` exposure and namespace `atlassian`. Without codemode, call `atlassian_discover` with `kind:"tools", query:"search list get read"`; it activates only the explicitly named, already-registered tools and preserves the host's current tool selection. It never activates `apply` implicitly.

## Tools and complete journeys

| Tool/action | Purpose |
|---|---|
| `atlassian_discover` | Offline journeys, operation search, tools, docs or credential-free configuration status. Operation results page with `nextOffset`/`eof`. |
| `atlassian_search` | Explicit JQL or CQL; no invented query translation. One page, default25/max100. |
| `atlassian_list` | Contextual `editableFields`, Jira `createFields`/visible field catalog, Confluence custom `properties`; also projects/spaces/pages, comments, hierarchy, links, transitions and attachment metadata. |
| `atlassian_get` | Fresh issue/page/space/comment fetch; metadata and handle, no body preview. |
| `atlassian_read` | Exact source and RFC6901 pointer ranges; labeled derived text/outline. No network. |
| `atlassian_schema` | Selective offline operation/schema lookup; large outputs get a handle. |
| `atlassian_request` | Verified nondeprecated catalog operations, read-only methods and reviewed semantic POST reads only. |
| `atlassian_plan` | Local exact mutation preview, digest and immutable single-use plan. No network. |
| `atlassian_apply` | One-attempt write authorized by runtime write opt-in and exact plan ID; no additional UI dialog. Version checks for Confluence page/page-property updates. |

See [docs/journeys.md](docs/journeys.md) for project → issue → comments/links, space → page → sections/hierarchy, full range recovery, uncommon APIs and safe edits.

For example, in codemode:

```js
const page = await tools.atlassian_list({product:"confluence", kind:"spaces", limit:5});
text({items:page.items, nextCursor:page.nextCursor, complete:page.complete});
// Choose an explicit space ID before listing its pages; do not auto-select a title match.
```

Every fetched response has an opaque, runtime-scoped `handle`, `source` URL/content type/time/checksum/length metadata, and `readWith:"atlassian_read"`. Unknown response fields, ADF nodes and macros are retained. Metadata projection is not a summary of the body and is not evidence that all related context was fetched. Remote titles, comments, links, errors and content are **untrusted data**, never tool instructions or write approval.

## Editable fields and custom data

**Do not infer field availability from a default issue fetch or a missing/null value.** Jira `get`/`search` request a subset of values, not a capability inventory. Issue/page `get` results include a `fieldDiscovery` tool/input hint.

Use the high-level list modes before planning edits:

```js
const jira = await tools.atlassian_list({product:"jira", kind:"editableFields", id:"EXAMPLE-123", limit:25});
text({fields:jira.items, nextCursor:jira.nextCursor, complete:jira.complete});
const confluence = await tools.atlassian_list({product:"confluence", kind:"editableFields", id:"456", limit:25});
text({pageFields:confluence.requestFields, customProperties:confluence.items, nextCursor:confluence.nextCursor});
```

- **Jira existing stories/epics/issues:** `editableFields` calls the selected issue's `/editmeta`. Items expose `fieldId`, `name`, `custom`, `schema`, `required`, `operations`, and a source `pointer`. All returned system/custom fields are available across bounded pages; follow identical input plus `nextCursor` until `complete`. Due date normally uses `duedate`; Start date, End date and other planning dates may be custom fields with tenant-specific IDs. Use the discovered ID, never assume a particular `customfield_N` number. Read the source handle at `item.pointer` for full metadata or `allowedValuesPointer` for large option sets. `issueValuePointer` addresses the value in a **separately fetched issue handle**. Request those IDs via `get.fields`, or explicitly opt into all values with `fields:["*all"]`.
- **Jira catalog/creation:** `fields` uses the non-admin `/field` endpoint and retains visible system/custom field schemas; it is not evidence a field is editable on a particular issue. `createFields` requires `id` (project ID/key) and `issueTypeId`, and returns paginated contextual create metadata. Permissions, screens, custom-field contexts and workflow state can hide fields or make edit metadata empty. A field missing from these results is not proof Jira does not support it; API credentials may differ from the UI user. Status changes use transitions.
- **Confluence pages:** there is no Jira-style field-level edit-metadata endpoint. `editableFields` returns all top-level `updatePage` **`requestFields`** from the verified offline schema (including nested body/version schemas and local `schemaRef` lookups), plus one bounded page of custom content properties in **`items`**. `limit`/`nextCursor` apply to properties, not the fixed request-field list. `editabilityVerified:false` makes clear this is the REST-supported surface, not a permission guarantee. `properties` lists only the custom properties. Each item includes its ID/key/version, value type and `valuePointer`; exact arbitrary JSON values remain in the response handle. `propertyOperations` names verified create/update/delete operations; new property keys are not restricted to keys that already exist. For other Confluence resources, use `schema` for the selected write operation.

Confluence content properties are often app-managed metadata, **not** the “Page Properties” tables/macros visible inside a document. Those macros are edited in the page body. Do not overwrite unfamiliar app properties. Server permissions, workflow conditions and validation can still reject a later write; discovery is read-only and does not automatically validate every proposed tenant-specific field value.

## Completeness and lifecycle

- Search/list are one page. Follow `nextCursor` by repeating the **same input** plus cursor; modifying query, fields, limit, kind, product or scope fails. Upstream next tokens/links are never exposed as service cursors. A cursor is immutable/replayable, not an implicit current selection. Cycles and missing continuations fail explicitly.
- Jira offset/token and Confluence link pagination are followed explicitly. Any oversized upstream page, including an unpaginated related array, uses bounded **local snapshot** pages with the same exact source handle. Local records drain without network requests before resuming any upstream continuation; no records are dropped and the snapshot is not refetched. No recursive crawling or arbitrary attachment/link fetching occurs. `total` appears only when upstream supplies it.
- Whole-response `read` in `raw` mode returns the exact UTF-8-decoded upstream source string, including whitespace, CRLF and Unicode. Concatenating range `text` until `eof` recovers it exactly. Pointer strings are unchanged; other pointer values use labeled JSON serialization, not original lexical formatting.
- Offsets/lengths are **JavaScript UTF16 code units**, not UTF-8 byte offsets. Default range2000/max16000. Out-of-bounds offsets, malformed/missing pointers and invalid lengths fail. Offset at EOF returns an empty final range.
- Derived outlines have storage heading locators pointing into the original `/body/storage/value` string. ADF headings have stable JSON pointers, not invented byte offsets. Unknown nodes/macros remain recoverable in raw source; derived text is only a searchable projection, not a lossless renderer. Outline `text` ranges page the serialized derived outline, not the underlying storage string. The convenience `headings` array is included only when that whole serialization is ≤16000 UTF16 units; larger outlines remain recoverable by stitching `text` ranges.
- Model text is bounded independently of structured output. A shortened preview includes recovery instructions. No complete source is silently truncated to fit a response limit: oversized responses fail.
- Sources live in a lazy-created private runtime subdirectory (mode0700), with exclusive mode0600 files, random IDs and verified checksums. No tool accepts caller filesystem paths. `storeDir` is only a trusted test/service construction option; only the created runtime child is removed on close, not a borrowed parent directory.
- Shutdown, reload, session replacement and tree navigation invalidate handles, cursors and plans and delete owned sources. Toggling write opt-in alone preserves read sources/cursors. Tree navigation alone resets service handles/cursors/plans without replacing the extension runtime, so the toggle persists. Pi 1.0.4 recreates the extension runtime on new/resume/fork/session replacement and reload/restart; the toggle then resets to the env/CLI baseline. Old transcript handles do not survive a restart: **re-fetch**. A process crash can leave private OS-temp directories; there is no crash-recovery promise or cross-session cache. Do not persist these handles as durable evidence.

## Write safety

### Runtime write opt-in

Read-only is the default. To opt in at startup without editing credentials:

```sh
dotenvx run -- pi -e ./index.ts --atlassian-allow-writes
```

In the interactive TUI, run **`/atlassian-writes`** with no arguments to toggle ON/OFF. A notification and small footer status report the state. Arguments (including `on`/`off`) are rejected without toggling. The command requires both `ctx.mode === 'tui'` and `ctx.hasUI`; it is not available in RPC, print or JSON modes. There is no model-facing enable tool.

Precedence and scope:

1. A new extension runtime snapshots `ATLASSIAN_ALLOW_WRITES === '1'` (all other values mean OFF).
2. The boolean CLI flag `--atlassian-allow-writes` enables opt-in. Parsed flags are read at session start or lazy first use, **after** Pi invokes the factory. Omission inherits the environment; only CLI `true` overrides it. A false flag value does not force an environment-enabled runtime OFF. Use the bare flag syntax above; this extension does not register `--no-atlassian-allow-writes`.
3. A valid TUI toggle becomes the runtime-local override, taking precedence over that initial env/CLI state. It survives service resets caused by tree navigation alone, which does not replace the extension runtime. Pi 1.0.4 recreates the runtime on new/resume/fork/session replacement, as well as reload/restart: each fresh runtime initializes from env/CLI, not from the previous toggle or transcript.

Controls do not modify `process.env` or credential files, create a service, or make network calls. Toggling an existing service uses a trusted non-tool `service.setAllowWrites(boolean)` control, **without** closing/recreating it: exact source handles and read cursors stay valid. `discover {kind:"status"}` and new plans report the effective `writesEnabled` state.

OFF invalidates all write plans and revokes pending applies, including those awaiting Confluence version checks or a transport concurrency slot. Revocation generations and abort signals prevent a not-yet-dispatched write; turning ON again cannot revive an old plan or pending write. Create and review a fresh plan. Unrelated reads are not cancelled. **OFF cannot roll back an already-dispatched upstream mutation**; cancellation after dispatch can leave an uncertain outcome requiring a fresh read and reconciliation. Closed services cannot be re-enabled.

**Turning writes ON authorizes planned mutations; there is no additional TUI approval dialog or callback.** Enable it only when you want the agent to perform writes. Immutable plans, exact plan confirmation, version checks and single-attempt dispatch remain mandatory.

`plan` validates the recognized operation's required path/query/body and previews the exact method, configured target and serialized payload. Plans may be prepared while writes are OFF and applied after enabling; switching OFF always revokes existing plans. It performs no tenant call, even when writes are enabled. Large previews are recovered from the plan's handle. Inspect the whole preview, not just a shortened model snippet.

`apply` requires `confirm` to exactly equal `planId` and effective runtime write opt-in ON. It does **not** call `ctx.ui.confirm` or require a UI: startup env/CLI opt-in also authorizes writes in **RPC, print and JSON/headless** execution. Plans report `approvalRequired:false`. Read-only remains the default, and no model tool or remote document can turn writes ON.

Plans are consumed/locked before asynchronous network work; failed, cancelled and concurrent applications cannot reuse them. Mutations are attempted once, with no retries even after429/5xx/network failures. An uncertain outcome requires a fresh read and reconciliation, not blind resubmission.

Confluence page and page-property PUTs require `expectedVersion` and `body.version.number = expectedVersion + 1`. For a property, use its own version, not the containing page's version. Apply re-reads that page/property version, rejects stale plans and lets server conflicts surface; it never rebases. **There is no general atomic Jira CAS guarantee.** Read the current issue, contextual edit/create metadata and available transitions before planning Jira edits. Static schema validation cannot establish tenant permissions or writable custom fields.

## Limits and unsupported features

| Optional variable | Default | Accepted bounds |
|---|---:|---:|
| `ATLASSIAN_TIMEOUT_MS` | 30000 | 1–120000; includes queueing, retries and response reads |
| `ATLASSIAN_MAX_RESPONSE_BYTES` | 8388608 | 1–33554432 |
| `ATLASSIAN_MAX_RETRIES` | 2 | 0–5; reads only |
| `ATLASSIAN_MAX_RETRY_DELAY_MS` | 5000 | 0–30000 |
| `ATLASSIAN_MAX_CONCURRENCY` | 4 | 1–16 |
| `ATLASSIAN_MAX_STORE_BYTES` | 67108864 | 1–536870912 |

Invalid optional bound values use their documented default. Private source count is capped at2000; cursor count at4000. Start a new runtime and re-fetch when a limit is reached. No authentication retries; bounded429/5xx/network read retries honor `Retry-After`, refusing server delays beyond the configured bound. Cancellation propagates through fetch, queueing, retry waits and response reads. Redirects are rejected, and pagination must preserve the configured origin, product root and verified operation path.

Unsupported: multipart/upload/download/binary content, custom user headers, arbitrary URLs, remote schema refs, deprecated/retired operations, recursive crawls, a universal cross-product relationship API, complete HTML/ADF rendering, complete JSON Schema validation, and automatic tenant-specific writable-field validation. Validation checks structural types, required properties, enums, numeric bounds and `allOf`, but not every format/union/pattern/constraint. Generic path parameters accept documented dotted property keys and colon-bearing account keys as encoded single segments, while rejecting separators, traversal segments, percent encoding, query/fragment characters and whitespace. High-level resource IDs retain stricter validation. Wire path/query numeric strings are validated numerically and serialized without changing their original identity; JSON bodies must follow their documented numeric types. `get` supports Jira comments through the reviewed read-only `POST /rest/api/3/comment/list` with safe numeric IDs; larger IDs/issue-scoped single-comment reads use generic `getComment`. Confluence `get comment` means footer comment; inline comments use verified generic operations. Some schema/header/serialization combinations explicitly fail rather than guessing.

## Offline catalog maintenance

The checked-in [catalog provenance](docs/catalog/provenance.json) records URLs, upstream SHA256 hashes and retrieval times. The compact index has839 operations in the current snapshot; operation details and individual components are separate lazy-loaded files. Startup does not load schemas or fetch specs. Confluence paths include the server's `/wiki/api/v2` prefix, rather than guessing from path fragments.

```sh
npm run catalog:update
npm run check
npm test
```

The generator fetches only these public official documentation-linked specs, with no tenant credentials:

- <https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json>
- <https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json>

CQL's V1 exception is separately documented in provenance. Reviewed semantic POST reads are enhanced JQL and comment lookup by IDs; other POSTs remain mutations even if their names sound like reads. Generated content ordering and filenames are deterministic for identical upstream specs; retrieval timestamps deliberately change. Review generated diffs and upstream API changes before release. On systems where Node needs the OS trust store, use `NODE_USE_SYSTEM_CA=1 npm run catalog:update`; never disable TLS verification. These artifacts are derived from Atlassian specifications; upstream notices are retained in provenance/operation data.

## Validation

```sh
npm run check             # strict implementation typecheck, independent tests excluded
npm test                  # injected-fetch offline tests, no live API
# Supervisor-only explicit live read-only suite:
dotenvx run --strict --overload -- npm run test:e2e
```

`npm test` includes unit, extension and transport regression suites; unit tests also import catalog, transport, field-discovery and write-control case suites. `test:e2e` sets `ATLASSIAN_E2E=1`, uses Node system CA trust and calls the same service. It performs read-only authentication/list/search and selected issue/page context assertions, with no tenant value logging. Jira enhanced search is bounded to `updated >= -30d`; an empty result skips only selected-issue context, not authentication/list/search checks. Genuine service failures remain test failures. Startup never runs tests. The implementation was validated offline; live tenant behavior depends on scopes, permissions and product configuration and must be checked by the supervisor. `workflows/v1/` and `docs/research/*-v1.md` retain historical build contracts/reviews; their former interactive approval requirement is superseded by the current write policy above.
