# cds-csrf-cache

A CAP plugin that caches the CSRF token for every destination-backed S/4 remote service, instead
of letting a fresh token be fetched on every single write.

## Why

The SAP Cloud SDK's CSRF middleware (used internally by `cds.RemoteService` for a destination with
`csrf` configured) fetches a brand-new token before every non-GET request. S/4 tokens are valid for
30 minutes, so almost all of those fetches are redundant - they just double the number of requests
sent for every `POST`/`PUT`/`DELETE`.

This plugin fetches the token once, keeps it in memory, and refreshes it proactively in the
background before it expires, so request-path latency no longer includes a token fetch except for
the very first request after startup (or after an unexpected rejection).

## How it works

- **`CsrfTokenCache`** (`src/CsrfTokenCache.ts`) is the actual cache. It is framework-agnostic - it
  only needs an async `fetchToken()` function and knows nothing about HTTP or CAP. It:
  - serves the cached token as long as it is within `validitySeconds` of being fetched,
  - schedules a background refresh `bufferSeconds` before that limit, so the buffer only decides
    *when* to refresh early - it does not shrink how long a token may still be used if that
    background refresh fails; the cache keeps serving the last known token until the real
    `validitySeconds` limit is hit,
  - deduplicates concurrent callers into a single in-flight fetch,
  - exposes `invalidate()` for a caller that learns the token was rejected out of band.

- **Two independent token-fetch implementations** plug into that cache, matching how the SAP Cloud
  SDK and native `fetch` are already treated as separate paths elsewhere in this project - they are
  never merged into one "smart" client:
  - `buildCsrfTokenFetcher` (`src/csrfFetch.ts`) uses Node's native `fetch` directly against a plain
    URL. It has no SAP Cloud SDK or CAP dependency and works against any plain HTTP(S) endpoint -
    the piece to reach for outside of any CAP service.
  - `buildCapDestinationCsrfTokenFetcher` (`src/capDestinationTokenFetcher.ts`) is what
    `attachCsrfCache` uses for a connected `cds.RemoteService`. It does **not** hardcode a client:
    it reuses CAP's own `shouldUseCloudSdk()` decision
    (`@sap/cds/libx/_runtime/remote/utils/cloudSdkProvider.js`) - the same function
    `cds.RemoteService` itself calls for every other request against that destination - and picks
    the SAP Cloud SDK or CAP's own native-fetch executor accordingly. A BTP destination that routes
    through Cloud Connector (on-premise) or requires a client certificate always resolves to the
    Cloud SDK here too, for the same reason `cds.RemoteService` always uses it for that destination:
    that connectivity configuration only resolves into an Axios/Node-`https.Agent` shape, which
    native `fetch` (undici) cannot consume. Both `@sap/cds` internals this reaches into are
    exported-but-undocumented; if a future `@sap/cds` release moves them, the require fails
    gracefully and the fetcher tries the Cloud SDK first instead.

  The SAP Cloud SDK itself stays optional throughout, exactly as it is for `@sap/cds` - a project
  that only talks to plain/local destinations can run without `@sap-cloud-sdk/http-client` installed
  at all. `@sap-cloud-sdk/http-client` is only ever `require()`'d lazily, at the point a token fetch
  actually needs it, never as a static import; if it isn't installed, CAP's own `shouldUseCloudSdk()`
  already says so (via its own `isCloudSdkInstalled()` check) and the token fetch goes through native
  fetch instead - the plugin's `package.json` marks it an optional peer dependency accordingly.

- **`createCsrfFetch`** (`src/csrfFetch.ts`) wraps any fetch-compatible function so every mutating
  request is armed with the cached token (and its session cookie), and retried exactly once with a
  freshly fetched token if the backend answers `403` + `x-csrf-token: Required`. This half is fully
  usable on its own, outside of CAP, against any endpoint reachable via native `fetch`.

- **`attachCsrfCache`** (`src/attachCsrfCache.ts`) is the CAP-specific glue for a `cds.RemoteService`:
  it registers a `before("*")` handler that injects the cached token/cookie into every non-safe
  (non-`GET`/`HEAD`) outgoing request, and wraps `send()` so a `403` CSRF rejection invalidates the
  cache and retries once. It reads the very same `csrf` config CAP itself reads
  (`.cdsrc.json`'s `requires.<service>.csrf`, a sibling of `credentials` - see Configuration below).

- **`src/sharedCsrfCaches.ts`** is the registry behind `csrf.share`: instead of one cache per service,
  every service on the same destination can be handed *one* `CsrfTokenCache`, so a single token
  fetch serves all of them - and a token rejected on one of them is refreshed once for all of them.
  An S/4 CSRF token is bound to the HTTP session behind the destination, not to the OData service
  path it was fetched from, which is what makes this valid; see Configuration below for what
  exactly has to match before two services are allowed to share.

- **`cds-plugin.js`** is the actual CAP plugin entry point. CAP auto-detects and loads it for every
  package listed as a dependency that has this exact file name next to its `package.json`. It
  listens for the `served` lifecycle event and calls `attachCsrfCache` on every connected
  `cds.RemoteService` that has a destination and a `csrf` configuration - no service needs to call
  anything itself. A service without that configuration, or with `csrf.cache: false`, is left
  untouched (e.g. a `--with-mocks` stand-in used in dev/test). It `require`s the implementation
  lazily, inside that handler, and never at load time: `cds-env` requires this file in *every*
  tool that merely loads `@sap/cds` - `cds-typer`, `cds build`, eslint - and those run in a plain
  CJS runtime, so a top-level `require` of the compiled implementation would run just as well, but
  the lazy load also means a consuming project that pulls in this package before its `lib/` build
  output exists (e.g. a `file:`/git dependency checked out from source) fails gracefully instead of
  taking the whole host application down with it.

## Setup

1. Install the package:
   ```sh
   npm install cds-csrf-cache
   ```
   CAP auto-detects the `cds-plugin.js` next to its `package.json` in `node_modules` - this is what
   makes the plugin loader discover it, no further wiring required.
2. Every remote service already configured with a destination and a `csrf` entry (`.cdsrc.json`'s
   `requires.<service>.csrf`, either `{ "url": "..." }` or `true`) picks up the cache automatically
   the next time the server starts.

## Sample application

[`sample/`](sample/) contains two minimal runnable CAP apps: a backend that requires a CSRF token
for writes, and a consumer that talks to it using this plugin - see
[`sample/README.md`](sample/README.md) for how to run them and what to look at.

## Configuration

### Per-service, via the existing `csrf` config

This plugin extends the very `csrf` object CAP itself already reads
(`.cdsrc.json`'s `requires.<service>.csrf`) with three extra, plugin-specific settings:

```json
{
  "requires": {
    "zsd_o2c_order_processing": {
      "csrf": {
        "method": "get",
        "url": "/sap/opu/odata4/.../zsd_o2c_order_processing/0001/",
        "cache": true,
        "validitySeconds": 1500,
        "autoRefresh": true,
        "share": true
      }
    }
  }
}
```

| Field             | Read by      | Meaning                                                                                   |
|-------------------|--------------|--------------------------------------------------------------------------------------------|
| `url`             | CAP          | Path the CSRF preflight is sent to.                                                        |
| `method`          | CAP + plugin | Verb for the preflight. CAP itself defaults to `head` if unset; this plugin defaults to `get` (broader OData compatibility) when it isn't given. |
| `cache`           | plugin only  | Set to `false` to leave this service on CAP's default per-request CSRF handling instead of caching. Defaults to `true`. |
| `validitySeconds` | plugin only  | How long a fetched token is trusted before this plugin proactively re-fetches it. Falls back to the environment variable / hardcoded default below when unset. |
| `autoRefresh`     | plugin only  | Set to `false` to only fetch a replacement token lazily, on the first request after it went stale, instead of proactively in the background. Defaults to `true`. |
| `share`           | plugin only  | Set to `true` to share one cached token with every other service on the same destination instead of caching one per service, or to a string to share only within that named group. Defaults to the `csrf_token_share` environment variable, i.e. to `false`. |

`csrf: true` (no object, e.g. `zapi_sales_order_srv`) is also supported, exactly like CAP's own
default: the fetch URL falls back to the service's `credentials.path`, and every plugin-only field
falls back to its default.

### One token for several services on the same destination (`share`)

By default every remote service keeps a token of its own - four services on `s4-o2c-100` mean four
token fetches, four background refreshes, and four separate recoveries after an expiry. `share`
collapses those into one:

```json
{
  "requires": {
    "zsd_o2c_order_processing": { "csrf": { "url": "...", "share": true } },
    "api_purchaseorder_2":      { "csrf": { "url": "...", "share": true } },
    "api_purchaserequisition_2":{ "csrf": { "url": "...", "share": true } },
    "zapi_sales_order_srv":     { "csrf": { "url": "...", "share": true } }
  }
}
```

This is safe because an S/4 CSRF token is bound to the HTTP session behind the destination, not to
the OData service path it was fetched from: a token fetched via `zsd_o2c_order_processing`'s URL is
accepted on `api_purchaseorder_2` just as well, as long as both requests really run against the
same session. Two services therefore only share when **all** of this matches:

- the **destination name** (`credentials.destination`) - a token from another system or another
  backend client is not valid, and is never shared across destinations, even with `share: true` on
  both sides;
- the **`destinationOptions`** - they decide which concrete destination, and therefore which
  backend user/session, a destination *name* resolves to (`selectionStrategy`, `jwt`, ...); a
  different resolution can mean a different session, so it counts as a different token. The
  comparison is order-insensitive, so writing the same options in a different order still shares;
- the **share group**, if used: `"share": "writes"` shares only with other services configured with
  exactly that name. Use it to keep one service's token separate while the rest share one, e.g.
  when two services on one destination address different backend clients.

The first service served creates the shared cache, and its `url`, `method`, `validitySeconds` and
`autoRefresh` are the ones the shared cache runs with; a service joining with different settings is
served the existing cache and logged as a warning (a second cache on the same destination is exactly
what `share` was turned on to avoid). Consequently `invalidate()` after a `403` on *any* of the
participating services refreshes the token for all of them.

Turn it on for everything at once - without touching each service - with the `csrf_token_share`
environment variable below. A single service can still opt out again with `"share": false`.

### Environment-wide defaults

Used whenever a service's `csrf` config doesn't set the corresponding field:

| Environment variable          | Default | Meaning                                                            |
|--------------------------------|---------|---------------------------------------------------------------------|
| `csrf_token_validity_seconds` | `1800`  | How long a token stays valid on the backend (S/4 default: 30 min)   |
| `csrf_token_buffer_seconds`   | `60`    | How long before that limit the cache proactively refreshes          |
| `csrf_token_share`            | `false` | Default for `csrf.share` - set to `true`/`1`/`yes`/`on` to let all services of a destination share one token |

### Programmatic override

For cases the config can't express (mainly tests), pass options directly to `attachCsrfCache` - they
win over both the `csrf` config and the environment defaults:

```ts
import { attachCsrfCache } from "cds-csrf-cache"

attachCsrfCache(srv, { validitySeconds: 900, bufferSeconds: 30, share: true })
```

`share` works the same way here as in the config, and wins over it - `{ share: false }` keeps a
service on its own cache even though its `csrf` config asks for a shared one. `resetSharedCsrfCaches()`
disposes every shared cache and empties the registry; tests that attach shared caches should call it
between cases.

## Using the native-fetch half directly

Outside of any CAP service - e.g. a plain script or a non-CAP integration - the cache and the
native-fetch adapter can be used standalone:

```ts
import { CsrfTokenCache, buildCsrfTokenFetcher, createCsrfFetch } from "cds-csrf-cache"

const cache = new CsrfTokenCache(buildCsrfTokenFetcher("https://example.com/service/"))
const protectedFetch = createCsrfFetch(cache)

await protectedFetch("https://example.com/service/Entities", { method: "POST", body: "{}" })
```

## Tests

- `test/*.spec.ts` - unit tests (Vitest, run via `npm test`), covering the cache's timing
  behavior (caching, proactive refresh, hard expiry, invalidate, concurrent dedup), the native-fetch
  adapter, the CAP-client selection in `capDestinationTokenFetcher`, the shared-cache registry
  (scope identity, first-one-wins, reset) in `sharedCsrfCaches`, and the CAP wiring (config
  parsing, header injection, retry-on-403, sharing) in `attachCsrfCache`.
- `test/CsrfCache.e2e.test.ts` - an end-to-end test (run via `npm run test.e2e`) that exercises
  `CsrfTokenCache` and `createCsrfFetch` against a real local HTTP server standing in for an S/4
  gateway, over real sockets and real timers: caching across repeated requests, a timed proactive
  refresh, and recovery from an out-of-band token rejection.

## Development

- `npm run build` compiles `src/**/*.ts` to `lib/` (the shipped `main`/`types` entry point and what
  `cds-plugin.js` requires at runtime) via `tsc`. `npm publish` runs it automatically
  (`prepublishOnly`).
- `npm test` / `npm run test.e2e` run straight against the TypeScript sources in `src/` via Vitest -
  no build needed for that.

## Release

`.github/workflows/publish.yml` runs the test suite (Node 22/24) on every push and pull request
against `main`, and additionally publishes to npm when a tag matching `v*.*.*` is pushed:

1. Bump `version` in `package.json` (e.g. `npm version minor`, which also creates the matching git
   tag).
2. Push the commit and the tag: `git push && git push --tags`.
3. The `publish` job checks the pushed tag against `package.json`'s version, builds, and runs
   `npm publish --provenance --access public`.

This requires an `NPM_TOKEN` repository secret - an npm automation token with publish rights for
`cds-csrf-cache` - and, since `--provenance` is used, the workflow running from this repository on
GitHub (provenance ties the published package to the exact commit/workflow run that built it).
