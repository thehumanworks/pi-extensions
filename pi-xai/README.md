# xAI toolkit for Pi

`src/index.ts` exports a reusable, validated toolkit around the official
`@xai-official/sdk` **0.2.2**. The root `index.ts` adapts its tools to Pi 1.0.4.
The toolkit has no Pi imports and can also back an MCP server or another tool
host.

## Grok subscription login and CLI authentication

Sign in once with your Grok/X subscription:

```sh
pnpm install
pnpm auth login
```

The helper displays a device code and opens the xAI approval page. Use
`pnpm auth login --no-browser` on a remote machine. The full token response is
cached at `~/.config/xai/auth.json` in a file accessible only to your user
(`0600`), alongside its acquisition time and absolute expiry. Provider fields
are preserved under `token`. `XDG_CONFIG_HOME`, `XAI_AUTH_FILE`, or
`--auth-file PATH` can select another location.

Connect your existing `xai` CLI to the helper from this directory:

```sh
export XAI_API_KEY_CMD="node --experimental-strip-types \"$PWD/cli.ts\" token"
xai models --json
```

The installed CLI invokes the helper when it needs a key. `token` prints only
the access token to stdout and automatically refreshes the cache within five
minutes of expiry (half the lifetime for short-lived tokens). Refresh retains a
rotated refresh token, or the previous one when xAI omits it. Simultaneous CLI
processes share a lock and recheck the cache before refreshing. Writes use atomic
replacement; failed refreshes preserve the previous cache. If xAI omits
`expires_in`, the helper uses a one-hour lifetime, matching Pi's pinned provider.

The installed CLI gives an explicitly supplied key, `XAI_API_KEY`, or its saved
API key precedence over `--api-key-cmd`. Clear those overrides to use this login.
You can also pass the helper command directly as `xai --api-key-cmd "$XAI_API_KEY_CMD" models`.
After installing this package as a command, `xai-auth token` is equivalent to
running `cli.ts token`.

```sh
pnpm auth status   # Metadata only; never prints tokens or refreshes
pnpm auth refresh  # Force a refresh
pnpm auth logout   # Remove this helper's cached login
```

Login URLs, codes, and failures go to stderr. Authentication commands return
nonzero on failure; an expired/revoked refresh token requires `pnpm auth login`
again. `logout` clears the local cache and does not revoke the server session.

`./auth.ts` exports `createLocalAuth()` for Node hosts. Supply
`apiKey: () => auth.getAccessToken()` to `createXaiToolkit()` to use the same
refreshing cache outside Pi. `./src/oauth.ts` provides runtime-neutral device
login and refresh APIs; callers supply their own UI and persistence.

## Use in Pi

Install dependencies with `pnpm install`, then load `index.ts`
as an extension, or install this directory as a local Pi package:

```sh
pi -e /Users/tomas/tools/xai/index.ts
```

The extension first uses this helper's local login, refreshing it when needed.
If no local login exists, it reads your saved Pi `xai` login from
`~/.pi/agent/auth.json` (or Pi's configured agent directory). It accepts
`.xai.access_token` and Pi's canonical `.xai.access` field. `XAI_API_KEY` is the
fallback when neither login is stored. Explicitly injected keys or clients take
precedence. Pass `localAuthPath` to `registerXaiTools()` to override the helper's
cache location, and `authPath` to override Pi's read-only auth file.

Credentials are read lazily; loading the extension and calling local discovery
or helpers work without credentials. The saved token is rechecked before each
API call, so later Pi logins or token updates take effect without reloading the
extension. The helper owns and refreshes its own cache. Pi's auth file remains
read-only; Pi owns refresh for credentials stored there. A failed local refresh
is reported rather than silently switching to another account.

Tools use Pi's `codemode` exposure and are grouped in `xai_<module>` namespaces.
The extension leaves session settings alone. If code mode is absent from your
active tools, add `"defaultTools": ["+codemode"]` to Pi's settings. An explicit
`--tools` list also filters extension registration, so it must include the xAI
tools you intend to use (for example `xai_*`).

Start with capability discovery, then query live models:

```js
text(await tools.xai_meta_capabilities({}));
text(await tools.xai_models_language_list({}));
text(await tools.xai_meta_describe_tool({ name: "xai_responses_create" }));
```

Call functions from code mode with one argument object. Results are structured
JSON, so scripts can inspect/filter them before returning text to the agent:

```js
const result = await tools.xai_responses_create({
  model: "YOUR_MODEL_ID_FROM_THE_CATALOG",
  input: "Summarize the current documentation for this library.",
  tools: [await tools.xai_helpers_web_search({})],
});
text({ text: result.text, usage: result.usage });
```

For generated image bytes, pass each image to `image()` rather than printing
base64 text:

```js
const result = await tools.xai_images_generate({
  model: "YOUR_IMAGE_MODEL_ID",
  prompt: "A small red fox beside a lake",
  response_format: "b64_json",
});
for (const item of result.data) {
  if (item.b64_json) image(`data:image/jpeg;base64,${item.b64_json}`);
}
text(result.usage);
```

## SDK coverage

There are **69 tools** across eleven modules. Operation names below are the
programmatic method names; tool identifiers turn capitals into underscores, e.g.
`voice.customGetAudio` becomes `xai_voice_custom_get_audio`.

| Module      | Operations                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `responses` | `create`, `compact`, `get`, `delete`, `inputItemsList`                                                                                                                                                                         |
| `models`    | `list`, `get`, `languageList`, `languageGet`, `imageList`, `imageGet`, `videoList`, `videoGet`                                                                                                                                 |
| `images`    | `generate`, `edit`                                                                                                                                                                                                             |
| `videos`    | `generate`, `edit`, `extend`, `get`, `wait`                                                                                                                                                                                    |
| `files`     | `upload`, `list`, `get`, `delete`, `content`, `createPublicUrl`, `revokePublicUrl`                                                                                                                                             |
| `batches`   | `create`, `list`, `get`, `cancel`, `results`, `requestsAdd`, `requestsList`, `wait`                                                                                                                                            |
| `voice`     | `speak`, `transcribe`, `list`, `get`, `customCreate`, `customList`, `customGet`, `customUpdate`, `customDelete`, `customGetAudio`, `clientSecretsCreate`, `speechTags`, `checkSpeechText`, `stripInvalidSpeechTags`            |
| `tokenizer` | `encode`                                                                                                                                                                                                                       |
| `account`   | `apiKey`                                                                                                                                                                                                                       |
| `helpers`   | `toText`, `toInput`, `toJson`, `parsePartialJson`, `isFunctionCall`, `isImageGenerationCall`, `isMessage`, `isReasoning`, `webSearch`, `xSearch`, `codeExecution`, `collectionsSearch`, `mcp`, `imageGeneration`, `toolSearch` |
| `meta`      | `capabilities`, `listTools`, `describeTool`                                                                                                                                                                                    |

This covers every public resource method and functional helper in the pinned
SDK. The toolkit also re-exports SDK classes, types and errors for native
callers. Model IDs are strings, so newly available models work without changing
schemas. Family-specific model endpoints report live capabilities, context
limits and pricing; account lookup reports permissions and account/key status.

## Reuse outside Pi

```ts
import { createXaiToolkit } from "./src/index.ts";

const xai = createXaiToolkit({
  apiKey: async () => obtainKeyFromYourHost(),
  clientOptions: { maxRetries: 2 },
});

const models = await xai.models.languageList({});
const response = await xai.responses.create({
  model: models.models[0].id,
  input: "Hello",
});
console.log(response.toText()); // Native SDK ModelResponse.

// JSON transport entrypoint, suitable for another tool host:
const result = await xai.executeTool("xai_models_list", {});

// Every descriptor has name, module, description, parameters (JSON Schema),
// annotations, and execute(args, { signal, onUpdate }).
for (const descriptor of xai.tools) {
  registerWithYourHost(descriptor);
}
```

An existing `SpaceXAI` client can be passed as `{ client }`; each toolkit owns
its client initialization. An async key supplier is checked on each API call,
with concurrent calls sharing that work. The client is reused while the key
matches and replaced when it changes. A failed initialization can be retried.
Custom fetch, base URL, timeout, retry and HTTP hooks are available
through `clientOptions` or an injected SDK client.

Each module also exports its own factory, taking
`{ getClient(): Promise<SpaceXAI> }`. `getClient()` on the toolkit exposes the
native SDK when a caller needs native streams, async pagination iterators, or
`Blob`/`File` inputs directly.

For MCP, map `descriptor.parameters` to the tool's `inputSchema` and call
`descriptor.execute`. Convert its JSON result to your transport's response
shape; MCP requires object-valued `structuredContent`, so wrap primitive/array
helper results if needed. No MCP server is started by this extension.

## Inputs and results

- Generation/transcription tools accept SDK body fields directly. File and
  stored resource operations use `id`; query/body fields are grouped when the
  SDK takes multiple arguments. Voice lookup uses `voice_id`. Full schemas are
  available through `meta.describeTool` and each tool descriptor.
- API calls accept optional `request` options: `timeout`, `idleTimeout`,
  `maxResponseBodyBytes`, `maxRetries`, `retryBeforeOutput`, `headers`, and
  `http: { body: true }`. `CallContext.signal` supplies cancellation. Polling
  tools use `interval` and `timeout` plus the context signal, matching the SDK.
- SDK request bodies retain extra fields and nullable parameters. Known fields
  are validated before resolving credentials. Mutually exclusive media sources
  are validated, including `image`/`images` and transcription `file`/`url`.
- Uploads accept
  `{ data, encoding?: "base64" | "utf8", mime_type?, filename? }`. Base64 is the
  default. Image/video inputs also accept SDK URL/file-ID references; response
  image content can use the same encoded object as its `image` field. The
  toolkit does not read host files; a host can provide bytes through its own
  file tools.
- Native module methods return SDK responses. Registry execution returns JSON:
  all media items, usage and HTTP metadata are retained; headers become plain
  objects. Model responses additionally contain `text`, `parsed`, `input` and
  the original `raw` response. Binary responses contain `data`, `encoding`,
  `mime_type`, `byte_length` and `http`.
- `responses.create({ stream: true })` forwards SSE events to `onUpdate` and
  returns the completed response. Errors reject and streams close on completion,
  callback failure or cancellation. Tool calls from client function/shell tools
  are returned for the caller to execute and feed back to Grok.
- Responses default to `store: false`, matching the SDK. To continue without
  storage, append returned `input` to your conversation. Retrieval or
  continuation by response ID requires `store: true` on the original response.
  Compacted output should be passed back unchanged.
- Lists return one page and its cursor. Follow `pagination_token`, or use
  `query.after = last_id` for response input items when `has_more` is true.
  Video/batch polling timeouts do not cancel the remote job.
- Web/X search, collections search, server Python execution, image generation,
  remote MCP and deferred tool search are available through response tool
  configurations. Realtime voice session transport and collection administration
  are outside this SDK; it provides realtime client-secret creation and
  collection search configuration.

## Verification

```sh
pnpm check
pnpm lint
pnpm test
```

The unit suite runs against injected clients and mocked SDK fetches. The separate Pi suite runs an isolated real Pi session and
QuickJS code-mode VM, discovering namespaces and executing toolkit calls through
Pi's tool pipeline, using temporary directories and in-memory settings/auth.
Neither suite makes live xAI or LLM calls.
The auth suite covers device polling, cancellation, private atomic storage,
refresh rotation, cache recovery, CLI output, and refresh coordination across
four separate processes. It uses temporary caches and mock transports.

`pnpm e2e:cli-auth` additionally drives the installed `xai` CLI through
`XAI_API_KEY_CMD`, refreshing an expired fixture login and making two model
requests. It uses only a local HTTP fixture server and temporary caches; no real
credentials or provider calls. Set `XAI_CLI_BIN` if the binary is outside PATH.

To run an optional live test with `gpt-6-luna` through Pi:

```sh
pnpm e2e
```

This requires existing OpenAI credentials for Pi and either a saved Pi `xai`
login or `XAI_API_KEY`. It loads the
default entrypoint from disk and lets the model discover tools, inspect schemas,
and query read-only xAI model metadata. Evidence is saved under `.artifacts/`;
the command exits nonzero if any required check fails. Credentials and Pi settings
are held in memory, and token refresh does not modify global auth files. The live
test is separate from the default test suite.

SDK reference: [official TypeScript SDK](https://github.com/xai-org/xai-sdk-ts).
OAuth reference: [xAI OIDC discovery](https://auth.x.ai/.well-known/openid-configuration)
and [Grok CLI authentication](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md).
Pi reference: the installed package's `docs/codemode.md` and
`docs/extensions.md`.
