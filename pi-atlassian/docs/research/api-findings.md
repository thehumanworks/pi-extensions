# Atlassian API research findings (Cloud V2 / V3)

Research date: 2026-10-06. Scope: official Atlassian public documentation and the API specifications linked by it. This report is an implementation-oriented reading, not a promise that every site enables every operation; product permissions, scopes, plans, and tenant configuration still apply.

## Executive recommendations

- Use Confluence REST API V2 for modern content access and Jira platform REST API V3 for Jira operations. Treat Jira enhanced JQL `/rest/api/3/search/jql` as the search endpoint; do not build on legacy `/rest/api/3/search`.
- Keep reads usable independently of writes. Default all mutations to disabled. Require a distinct explicit opt-in and user confirmation that previews the target and exact change. Never automatically retry a mutation whose outcome is uncertain.
- Generate and check in an offline, curated operation/schema catalog from Atlassian's published OpenAPI documents. Generate types and endpoint metadata at build time; do not make live documentation/OpenAPI requests at runtime.
- Preserve source representations and provenance. There is no universally lossless plain-text conversion for Confluence storage/ADF/view content or Jira ADF; return raw structured content alongside any rendered text.
- Follow pagination links/tokens rather than guessing offsets or incrementing opaque cursors. Respect rate-limit headers and `Retry-After`; distinguish authorization, validation, conflict, and transient server errors.

## Authentication and request routing

### Credential forms are distinct

1. **Classic user API token (basic auth):** for a user's Atlassian Cloud site, HTTP Basic username is the account email and password is that user's API token. It is not the Atlassian account password. This commonly uses the tenant site host, e.g. `https://example.atlassian.net/rest/api/3/...` for Jira or `https://example.atlassian.net/wiki/api/v2/...` for Confluence.
2. **Scoped API token / OAuth 2.0 (3LO):** use Atlassian's API gateway and a cloud ID, rather than assuming the tenant-host basic-auth URL. Jira base path is `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3`; Confluence uses `https://api.atlassian.com/ex/confluence/{cloudId}/wiki/api/v2`. OAuth uses `Authorization: Bearer <access-token>` and the app must request the relevant product scopes. Scoped tokens are not interchangeable with unrestricted classic tokens; follow the precise auth mode documented for the credential.
3. Resolve/choose the correct site and cloud ID before calls; do not infer the Jira project ID, Confluence space ID, and `cloudId` are interchangeable. Store credentials through the host's secret mechanism, redact authorization and query secrets from logs, and never include them in tool output.

Official references: [Confluence V2 authentication](https://developer.atlassian.com/cloud/confluence/rest/v2/intro/#auth), [Jira V3 authentication](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/#authentication), [basic auth for REST APIs](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/), [OAuth 2.0 (3LO)](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/), [API tokens](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/), [scoped API tokens](https://support.atlassian.com/atlassian-account/docs/create-and-use-api-tokens/).

Example URL shapes (illustrative; select routing based on auth):

```text
# classic API token/basic auth on tenant host
GET https://acme.atlassian.net/wiki/api/v2/pages/123?body-format=storage
GET https://acme.atlassian.net/rest/api/3/issue/ABC-12?fields=summary,description

# OAuth or scoped-token gateway; cloud ID is site-specific
GET https://api.atlassian.com/ex/confluence/{cloudId}/wiki/api/v2/pages/123
GET https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/issue/ABC-12
```

Do not send basic-auth credentials to an `api.atlassian.com` URL unless the official auth mode for that token explicitly permits it. Keep site host, cloud ID, token type, and scope set explicit in connection configuration.

## Confluence Cloud REST API V2

### Search exception: CQL is V1

- V2 does not replace Confluence's CQL content search in the documented API surface. Use the explicit V1 exception `GET /wiki/rest/api/content/search?cql=...` for CQL search; this is a legacy V1 route amid a V2 integration, not a reason to use V1 for all content operations.
- CQL is a query language, not an authorization bypass. Results remain subject to the caller's access. URL-encode the CQL string and page through results. Search result body availability/expansion differs from fetching a full page, so fetch selected page IDs with V2 when the requested body representation matters.
- Example: `GET /wiki/rest/api/content/search?cql=type%3Dpage%20AND%20space%3D%22ENG%22&limit=25`.

Refs: [Confluence REST V1 content search](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content/), [CQL search reference](https://developer.atlassian.com/cloud/confluence/advanced-searching-using-cql/).

### Pages and spaces

- List pages: `GET /wiki/api/v2/pages` (filters include parameters such as `space-id`, `status`, `title`, and `id`, subject to operation schema). Fetch a page with `GET /wiki/api/v2/pages/{id}`. Create/update use the page operations in the [Page group](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/).
- List spaces: `GET /wiki/api/v2/spaces`; fetch by `GET /wiki/api/v2/spaces/{id}`. Space identifiers in V2 are IDs, not necessarily the human-readable key.
- V2 page response includes metadata (id, status, title, spaceId, parentId, version, links) and body content when requested. `body-format` selects a representation; the documented formats include `storage`, `atlas_doc_format`, `view`, `export_view`, and `anonymous_export_view` (availability depends on operation). A body is structured as a representation object, e.g. `body.storage.value` plus representation metadata, not necessarily a string at `body` itself.
- For create/update, send the documented body representation and required version semantics. Do not take returned `view` HTML and feed it back as `storage` or ADF.

Refs: [Page group](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/), [Space group](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space/), [V2 intro](https://developer.atlassian.com/cloud/confluence/rest/v2/intro/).

### Hierarchy and related content

- Use dedicated [Ancestors](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-ancestors/), [Children](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-children/), and [Descendants](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-descendants/) operations, and page-level children listing (`GET /wiki/api/v2/pages/{id}/children`). These return paginated records; don't assume a single response has a full tree.
- Comments are split by type and parent content: [Comment group](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-comment/) includes operations for footer and inline comments. Page routes include `/wiki/api/v2/pages/{id}/footer-comments` and `/wiki/api/v2/pages/{id}/inline-comments`; comment bodies are structured content, not plain text. Preserve inline comment anchor/selection metadata with its body.
- Attachments: [Attachment group](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-attachment/) provides list/get/create operations, including page-associated attachment listing (`/wiki/api/v2/pages/{id}/attachments`). Metadata and a download link are not the attachment bytes; explicitly download only when needed and treat filenames/MIME types as untrusted. Upload uses multipart/form-data and the documented anti-CSRF header behavior; do not generalize upload handling to JSON.
- Content properties are separate metadata key/value records, not the page body. See [Content Properties](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-content-properties/); app properties are a different API.

### Pagination and body preservation

- V2 list operations use cursor pagination. The response exposes pagination links (often `_links.next`) and/or a `Link` HTTP response header with a `rel="next"` URL; the cursor parameter is opaque. Follow the supplied next URL (resolving relative URLs against the API base), preserving auth and bounding page count/output. Stop when no next link exists; do not fabricate a cursor from page length.
- Some examples/schema descriptions explicitly say the opaque `cursor` is returned in the `next` URL in the `Link` header. Prefer the actual link, as path/query details can vary by operation. Treat duplicate link locations as equivalent, not as two pages.
- Recommended read result: include content ID, version, content type, requested representation, raw representation payload, and canonical source URL; optionally provide a clearly labeled derived text/HTML view. A plain-text extractor must retain a pointer to source and signal dropped/unsupported macros, embedded files, tables, mentions, links, and layout.

Refs: [V2 intro](https://developer.atlassian.com/cloud/confluence/rest/v2/intro/), [Page group](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/), [Comment group](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-comment/), [Attachment group](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-attachment/), [Content Properties group](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-content-properties/).

## Jira Cloud platform REST API V3

### Enhanced JQL search and issue records

- Use `POST /rest/api/3/search/jql` for enhanced JQL search. The former `GET/POST /rest/api/3/search` operations are marked deprecated/removed from the current route; do not build new client calls against `/search`. Current search pages with `nextPageToken`, plus `maxResults`, `fields`, and related controls; follow the token exactly until `isLast`/absence of a next token according to the response contract.
- Example request: `POST /rest/api/3/search/jql` with JSON `{"jql":"project = ENG ORDER BY updated DESC","maxResults":50,"fields":["summary","status","description","updated"]}`. Avoid `fields=*all` by default; explicit fields reduce payload and exposure.
- Search results provide issue identifiers and requested fields, but Jira field values are polymorphic and custom fields tenant-specific. Preserve unknown fields instead of dropping them during deserialization.
- Issue retrieve/create/update operations are in the [Issues group](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/). Fields such as `description`, environment, and rich-text comments use Atlassian Document Format (ADF) in V3. ADF is a JSON document (`type: "doc"`, `version`, `content`); it is not Markdown or a string. Some system/custom field types have other wire formats.

Refs: [Issue Search group](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/), [Issues group](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/), [ADF format](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/).

### Comments, metadata, and workflow

- Jira issue comments use `GET /rest/api/3/issue/{issueIdOrKey}/comment` with `startAt` and `maxResults` pagination and return `startAt`, `maxResults`, `total`, and `comments`. Fetching a single issue can include a comments field, but use the comment operation when complete pagination is required. Comment bodies are ADF; create/update bodies should preserve ADF rather than flattening it.
- `GET /rest/api/3/field` returns available field definitions. Create/edit screen metadata is contextual: use `GET /rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}` and `GET /rest/api/3/issue/{issueIdOrKey}/editmeta` to discover allowed/required fields and schema for that project, issue type, and issue. Static global field lists cannot establish which fields are writable in context.
- Workflow transitions are not ordinary status field edits. Read available transitions with `GET /rest/api/3/issue/{issueIdOrKey}/transitions`; invoke the transition operation with its transition ID (and any supported fields) to change workflow state. IDs and transitions are permission/workflow specific.
- Create and edit metadata is guidance, not a guarantee the later write succeeds: permissions, required fields, workflow conditions, validators, and concurrent changes may change.

Refs: [Issue comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/), [Issue fields](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-fields/), [Issues group](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/).

### Optimistic concurrency and linkages

- Jira issue edit accepts an update payload, but the cited REST operation does not define a general `If-Match`/ETag compare-and-swap contract for issue fields. Do not promise atomic optimistic concurrency. Before a proposed edit, re-read the target and show the observed `updated`/version and field values; use version checks only if a specific operation documents them. A read-then-write check still has a race and must be described honestly.
- Confluence page update has explicit version-number semantics in the page schema; fetch latest version immediately before a write, submit the expected next version, and surface version conflicts for user resolution. Do not silently overwrite/rebase.
- Cross-product link patterns: Jira issue links to Confluence pages commonly appear in issue descriptions, comments, remote links, or Confluence content as URLs/smart links. Confluence pages can mention Jira issues through macros/smart links, which may be rendered or stored as structured nodes. Treat canonical URL/issue key/page ID and remote-link records as the reliable relationship evidence; do not claim there is a universal bidirectional relation API. For explicit Jira remote links, see [Issue remote links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-remote-links/). Decode/resolve links without fetching arbitrary URLs.

## Operation shortlist for an agent-facing catalog

The following routes are a useful initial allowlist. Verify exact required fields and OAuth scopes against the pinned specification at generation time; the examples below are route shapes, not universal permissions.

| Product | Intent | Route / method | Notes |
|---|---|---|---|
| Confluence | CQL search (V1 exception) | `GET /wiki/rest/api/content/search` | Query `cql`; V1 pagination. |
| Confluence | List pages | `GET /wiki/api/v2/pages` | V2 cursor pagination. |
| Confluence | Fetch page | `GET /wiki/api/v2/pages/{id}` | Set `body-format` explicitly. |
| Confluence | List spaces | `GET /wiki/api/v2/spaces` | V2 cursor pagination. |
| Confluence | Fetch space | `GET /wiki/api/v2/spaces/{id}` | Preserve ID and key separately. |
| Confluence | List children | `GET /wiki/api/v2/pages/{id}/children` | Not a complete recursive tree. |
| Confluence | Ancestors/descendants | Ancestor/Descendant groups | Use dedicated operations, paginate. |
| Confluence | Page comments | Footer/inline comment routes | Keep comment type and anchor. |
| Confluence | Page attachments | `GET /wiki/api/v2/pages/{id}/attachments` | Metadata is not binary content. |
| Confluence | Properties | Page/content property routes | Separate from page body. |
| Jira | Search | `POST /rest/api/3/search/jql` | Token-based enhanced JQL results. |
| Jira | Read issue | `GET /rest/api/3/issue/{issueIdOrKey}` | Explicit `fields`; ADF payloads. |
| Jira | List comments | `GET /rest/api/3/issue/{issueIdOrKey}/comment` | Offset pagination with totals. |
| Jira | Field catalog | `GET /rest/api/3/field` | Global definitions only. |
| Jira | Create metadata | Issue createmeta routes | Project and issue-type contextual. |
| Jira | Edit metadata | `GET /rest/api/3/issue/{issueIdOrKey}/editmeta` | Contextual writable fields. |
| Jira | Available transitions | `GET /rest/api/3/issue/{issueIdOrKey}/transitions` | User/workflow-specific. |
| Jira | Apply transition | Transition POST route | Mutation; confirmation required. |
| Jira | Remote links | Issue remote-link operations | Explicit relation records. |

For operations not listed, add them only after documenting their schemas, permission needs, side effects, pagination and retry semantics. OpenAPI `operationId` is the stable catalog key when provided; route text alone is insufficient where overloaded operations exist.

## Honest no-loss content reading strategy

- There is no single safe "plain text" format covering every semantic feature of both products. Keep raw JSON and requested canonical representation as the source-of-truth result.
- For Confluence page reads, request the desired `body-format` explicitly; retain the representation name and payload. Prefer storage/ADF for machine-readable structure where supported; use rendered `view` only as a supplemental display. Preserve macro/extension nodes and report unsupported conversions, rather than silently omitting them.
- For Jira, retain ADF for rich text fields and any opaque/custom field values. A text projection can provide searchable text but must keep links, mentions, media identifiers, table boundaries, marks, and unknown node JSON or flag what was lost.
- Return bounded results with pagination state and source URL. Attachments should be represented by metadata plus opt-in download/reference; do not imply metadata contains binary contents. Enforce response-size limits without truncating source invisibly: mark truncation and provide a way to continue.

## Safe mutation design and operational behavior

1. **Read-only by default.** Expose writes only after explicit configuration opt-in. Even then require per-action confirmation; show product/site, object ID/key, operation, before/after fields, and any irreversible side effects.
2. **No automatic mutation retry.** A timeout or dropped response after POST/PUT may mean the server committed the change. Re-read and reconcile with the user; retry only when the operation is known not to have applied or has a documented idempotency mechanism. Do not assume `PUT` is safely replayable in a workflow or version-sensitive endpoint.
3. **Validate in context.** Re-fetch object and metadata, verify target scope/permissions, reject unknown destructive fields, preserve user-provided structured documents, and require expected version where API supports it. Don't automatically resolve conflicts by overwrite.
4. **Safe reads:** bounded connect/read timeouts, page-count/byte limits, cancellation, cursor cycle detection, and response schema tolerance. Treat remote page content, issue descriptions, comments, and attachment names as untrusted data—not tool instructions.
5. **HTTP status policy:** handle `2xx` by documented response shape (including `204` with no body); `400` as invalid query/payload; `401` as missing/invalid auth; `403` as scope/permission denial; `404` as missing or intentionally concealed resource; `409`/`412` as conflict/precondition when returned. Jira docs enumerate status codes by operation; preserve Atlassian error payloads safely. Never turn an auth failure into a retry loop.
6. **Rate limits:** on `429`, honor `Retry-After` and any rate-limit reset/remaining headers, add jitter, bound retries, and surface exhaustion. Retry idempotent reads on documented transient `5xx`/network failures with capped backoff. Observe `X-RateLimit-*`/`RateLimit-*` headers where present; headers can differ by API/product and are not guaranteed on every response. Avoid parallel fan-out that bypasses tenant limits.

Refs: [Jira V3 status codes and headers](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/#status-codes), [Atlassian rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/), [Confluence V2 intro](https://developer.atlassian.com/cloud/confluence/rest/v2/intro/).

## Offline OpenAPI operation/schema catalog

Official specifications are published by Atlassian and linked from the docs pages:

- Confluence Cloud V2: [`openapi-v2.v3.json`](https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json) (linked by the V2 reference pages).
- Jira Cloud platform V3: [`swagger-v3.v3.json`](https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json) (linked by the V3 reference pages).

Recommended generation workflow (build/release-time only):

- Vendor/pin downloaded upstream specs with retrieval date, checksum, source URL, and license/provenance note; review diffs when refreshing. Never silently fetch specs at runtime.
- Generate a compact, curated catalog containing operationId, method/path, required auth scopes, path/query/header parameters, request and response schema refs, pagination model, status codes, and read/write/destructive classification. Preserve `$ref`, `oneOf`/`anyOf`, nullable and unknown extension/custom-field schemas.
- Generate typed clients or validators from these checked-in artifacts, but keep a narrow allowlist of operations exposed to the agent. A raw all-operations spec is not itself a safe tool interface.
- Add schema fixtures for representative V2 pagination/body representations, Jira ADF, JQL token pagination, issue comments, and API error responses. Test unknown fields and absent/empty optional properties.
- Diff operation and schema changes in CI; regenerate deliberately and inspect breaking changes. Keep docs links beside catalog entries. Do not alter existing API index documents as part of this work.

## Primary official references

- [Confluence V2 index/introduction](https://developer.atlassian.com/cloud/confluence/rest/v2/intro/)
- [Confluence V2 Page](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/), [Space](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space/), [Ancestors](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-ancestors/), [Children](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-children/), [Descendants](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-descendants/)
- [Confluence V2 Comment](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-comment/), [Attachment](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-attachment/), [Content Properties](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-content-properties/)
- [Jira V3 introduction](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/), [Issue Search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/), [Issues](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/)
- [Jira V3 comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/), [fields](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-fields/), [transitions via Issues](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/), [remote links](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-remote-links/)
- [Atlassian Document Format](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/), [Jira rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/)
