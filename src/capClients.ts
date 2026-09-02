import cds from "@sap/cds"

const LOG = cds.log("csrf-cache")

/**
 * What a connected `cds.RemoteService`'s `destination` can be: the *name* of a BTP destination
 * (from `credentials.destination`), or the inline destination CAP assembles from `credentials.url`
 * and its siblings - `{ name, url, username, ... }`, see `_getDestination()` in
 * `@sap/cds/libx/_runtime/remote/Service.js`. Both are valid destination references for either
 * client; only the name has to be wrapped in `{ destinationName }` before it is handed over.
 */
export type DestinationRef = string | Record<string, unknown>

/** A destination for log output: its name, or the URL of an inline `credentials.url` destination. */
export function describeDestination(destination: DestinationRef): string {
    if (typeof destination === "string") return destination
    return String(destination.name ?? destination.url ?? "inline destination")
}

/**
 * The destination reference a client takes: only a *name* needs the `destinationName` wrapper (and
 * the options that decide which concrete destination it resolves to); an inline destination is
 * already a reference both clients take as it is - the same distinction CAP's own `client.js` makes.
 */
export function toDestinationRef(destination: DestinationRef, destinationOptions: Record<string, unknown>): DestinationRef {
    return typeof destination === "string" ? { destinationName: destination, ...destinationOptions } : destination
}

/** As much of an HTTP response as a CSRF preflight needs - the part both clients report identically. */
export type ClientResponse = { status: number, headers: Record<string, unknown> }

/** One HTTP request against a destination reference - the single shape both clients are used through. */
export type HttpExecutor = (destination: DestinationRef, requestConfig: Record<string, unknown>) => Promise<ClientResponse>

export type CapInternals = {
    shouldUseCloudSdk: (destination: DestinationRef) => boolean
    nativeFetch: HttpExecutor
}

/** The SAP Cloud SDK's `executeHttpRequest` - the third argument is the one CAP's native client does not have. */
export type CloudSdkExecutor = (destination: DestinationRef, requestConfig: Record<string, unknown>, options: Record<string, unknown>) => Promise<ClientResponse>

/**
 * `cds.RemoteService` decides per request whether to route through the SAP Cloud SDK or Node's
 * native `fetch`, via `shouldUseCloudSdk()` in `@sap/cds/libx/_runtime/remote/utils/cloudSdkProvider.js`
 * (a BTP destination without a locally-resolvable URL, or with anything other than Basic/No auth,
 * always forces the Cloud SDK - that is what makes an on-premise/Cloud-Connector/mTLS destination
 * safe to call at all, since only the Cloud SDK resolves that connectivity configuration).
 *
 * This module asks that very function instead of deciding for itself, and executes through
 * `fetchClient.js`'s `executeHttpRequest` when it says native fetch - so neither the client choice
 * nor the destination resolution behind it (the `destinations` env var, Basic-auth headers, query
 * parameters) is reimplemented anywhere in this package. A rebuilt copy of those rules would be a
 * second source of truth that drifts away from CAP's silently; asking CAP cannot drift.
 *
 * The price is that neither module is part of `@sap/cds`'s public entry point - both are
 * internal-but-exported (`module.exports` on their own files, just not re-exported from `@sap/cds`'s
 * `index.js`), so a future release could move them without a deprecation notice.
 * {@link resolveCapInternals} isolates that risk: if the require ever fails, every caller falls back
 * to the SAP Cloud SDK - the only client left once `shouldUseCloudSdk()` can no longer be asked -
 * and `capDestinationTokenFetcher.e2e.test.ts` fails loudly on the next `@sap/cds` upgrade that moves either export.
 */
let capInternals: CapInternals | null | undefined

export function resolveCapInternals(): CapInternals | null {
    if (capInternals !== undefined) return capInternals

    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- must be a runtime require: not part of @sap/cds's public entry point, see the comment above
        const { shouldUseCloudSdk } = require("@sap/cds/libx/_runtime/remote/utils/cloudSdkProvider")
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { executeHttpRequest: nativeFetch } = require("@sap/cds/libx/_runtime/remote/utils/fetchClient")
        return capInternals = { shouldUseCloudSdk, nativeFetch }
    } catch (error) {
        LOG.warn("could not load @sap/cds's internal client-selection module, always using the Cloud SDK for csrf token fetches", error)
        return capInternals = null
    }
}

/**
 * The SAP Cloud SDK is an optional peer dependency, exactly as it is for `@sap/cds` itself
 * (`cloudSdkProvider.js`'s `getCloudSdk()`/`isCloudSdkInstalled()`): a project that only talks to
 * plain/local destinations can run without `@sap-cloud-sdk/http-client` installed at all, and
 * `shouldUseCloudSdk()` already returns `false` in that case. A static top-level import of the
 * package would defeat that - it fails at module load time regardless of whether this branch is
 * ever taken - so this, too, is a lazy, cached, failure-tolerant require.
 */
let cloudSdkExecutor: CloudSdkExecutor | null | undefined

export function resolveCloudSdkExecutor(): CloudSdkExecutor | null {
    if (cloudSdkExecutor !== undefined) return cloudSdkExecutor

    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- must stay lazy: the package is an optional peer dependency, see the comment above
        const { executeHttpRequest } = require("@sap-cloud-sdk/http-client")
        return cloudSdkExecutor = executeHttpRequest
    } catch {
        LOG.debug("@sap-cloud-sdk/http-client is not installed, csrf token fetches use @sap/cds's native fetch client")
        return cloudSdkExecutor = null
    }
}

/**
 * A csrf preflight *is* the token fetch, so the Cloud SDK's own csrf middleware must not fetch
 * another token for it. `cds.RemoteService` passes the very same option for its real requests
 * (`executeHttpRequestWithOrigin(..., { fetchCsrfToken: false })` in
 * `@sap/cds/libx/_runtime/remote/utils/client.js`) - with the difference that there, this plugin's
 * cache is what supplies the token instead. CAP's native client needs no counterpart: it only
 * fetches a token of its own when `requestConfig.csrf` is set, which this package never sets.
 */
const NO_NESTED_CSRF_FETCH = { fetchCsrfToken: false }

/**
 * The client CAP itself would use for a request against `destination`, as one {@link HttpExecutor} -
 * a pure function of what could be loaded, so the choice is testable without intercepting a runtime
 * `require()`. {@link resolveExecutor} is the same thing with both candidates resolved.
 *
 * Two cases go beyond what CAP does, both because failing the token fetch is worse than using the
 * other client: with the Cloud SDK wanted but not installed, CAP's native client is tried anyway
 * (CAP would throw from its own `require`), and with CAP's internals unavailable the Cloud SDK is
 * the only remaining option. If neither client can be had, the error names exactly what is missing.
 */
export function chooseExecutor(destination: DestinationRef, internals: CapInternals | null, cloudSdkFetch: CloudSdkExecutor | null): HttpExecutor {
    const viaCloudSdk: HttpExecutor | null = cloudSdkFetch
        ? (destinationRef, requestConfig) => cloudSdkFetch(destinationRef, requestConfig, NO_NESTED_CSRF_FETCH)
        : null
    // No way to ask CAP - the Cloud SDK is the client it picks for everything but a plain local destination.
    const useCloudSdk = internals ? internals.shouldUseCloudSdk(destination) : true

    if (useCloudSdk && viaCloudSdk) return viaCloudSdk
    if (internals) return internals.nativeFetch
    if (viaCloudSdk) return viaCloudSdk

    throw new Error(`No HTTP client available for destination '${describeDestination(destination)}': `
        + "neither the SAP Cloud SDK nor @sap/cds's native fetch client could be loaded.")
}

/**
 * The client CAP itself would use for a request against `destination`. Resolved per call, not once
 * per service, exactly as `cds.RemoteService` decides it per request - the `destinations` env var
 * and `cds.env.remote.native_fetch` may both change after a service was connected.
 */
export function resolveExecutor(destination: DestinationRef): HttpExecutor {
    return chooseExecutor(destination, resolveCapInternals(), resolveCloudSdkExecutor())
}
