import cds from "@sap/cds"
import { CSRF_TOKEN_HEADER, CsrfTokenFetcher, missingCsrfTokenError } from "./CsrfTokenCache"

const LOG = cds.log("csrf-cache")

type NativeFetchResponse = { data: unknown, headers: Record<string, string | string[] | undefined>, status: number }
type CloudSdkResponse = { status: number, headers: Record<string, string | string[] | undefined> }

/* eslint-disable no-unused-vars -- parameter names in these function-type signatures are documentation, not declarations */
type CloudSdkExecutor = (destination: unknown, requestConfig: unknown) => Promise<CloudSdkResponse>

export type CapInternals = {
    shouldUseCloudSdk: (destination: unknown) => boolean
    nativeFetch: (destination: unknown, requestConfig: unknown) => Promise<NativeFetchResponse>
}
/* eslint-enable no-unused-vars */

/**
 * `cds.RemoteService` decides per request whether to route through the SAP Cloud SDK or Node's
 * native `fetch`, via `shouldUseCloudSdk()` in `@sap/cds/libx/_runtime/remote/utils/cloudSdkProvider.js`
 * (a BTP destination without a locally-resolvable URL, or with anything other than Basic/No auth,
 * always forces the Cloud SDK - that is what makes an on-premise/Cloud-Connector/mTLS destination
 * safe to call at all, since only the Cloud SDK resolves that connectivity configuration).
 *
 * `buildCapDestinationCsrfTokenFetcher` reuses that exact decision instead of hardcoding a client,
 * so the token fetch always goes through the same path CAP itself would pick for the real request
 * on this service. Neither module is part of `@sap/cds`'s public entry point - both are
 * internal-but-exported (`module.exports` on their own files, just not re-exported from `@sap/cds`'s
 * `index.js`), so a future `@sap/cds` release could move them without a deprecation notice.
 * `resolveCapInternals` isolates that risk: if the require ever fails, every caller falls back to
 * treating the SAP Cloud SDK as the only option - the same one CAP would use once `useCloudSdk`
 * can no longer be asked for.
 */
let capInternals: CapInternals | null | undefined

function resolveCapInternals(): CapInternals | null {
    if (capInternals !== undefined) return capInternals

    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- must be a runtime require: not part of @sap/cds's public entry point, see the module comment above
        const { shouldUseCloudSdk } = require("@sap/cds/libx/_runtime/remote/utils/cloudSdkProvider")
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { executeHttpRequest: nativeFetch } = require("@sap/cds/libx/_runtime/remote/utils/fetchClient")
        return capInternals = { shouldUseCloudSdk, nativeFetch }
    } catch (error) {
        LOG.warn("could not load @sap/cds's internal client-selection module, always trying the Cloud SDK first for csrf token fetches", error)
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

function resolveCloudSdkExecutor(): CloudSdkExecutor | null {
    if (cloudSdkExecutor !== undefined) return cloudSdkExecutor

    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { executeHttpRequest } = require("@sap-cloud-sdk/http-client")
        return cloudSdkExecutor = executeHttpRequest
    } catch {
        return cloudSdkExecutor = null
    }
}

function firstCookie(setCookie: string | string[] | undefined): string[] {
    if (!setCookie) return []
    return Array.isArray(setCookie) ? setCookie : [setCookie]
}

function tokenFrom(headers: Record<string, unknown>, status: number, csrfUrl: string): { token: string, cookies: string[] } {
    const token = headers[CSRF_TOKEN_HEADER]
    if (status !== 200 || typeof token !== "string")
        throw missingCsrfTokenError(csrfUrl, status)
    return { token, cookies: firstCookie(headers["set-cookie"] as string | string[] | undefined) }
}

export type CsrfPreflightMethod = "get" | "head"

export type CapDestinationTokenFetcherOverrides = {
    capInternals?: CapInternals | null
    cloudSdkFetch?: CloudSdkExecutor | null
}

/**
 * Builds a {@link CsrfTokenFetcher} for a connected `cds.RemoteService`'s destination, letting CAP's
 * own `shouldUseCloudSdk()` decide between the SAP Cloud SDK and native `fetch` - see the module
 * comment above for why that decision must not be hardcoded to one client, and why the Cloud SDK
 * itself must stay optional. `overrides` exists so tests can supply fakes directly instead of
 * mocking a runtime `require()` of a deep `node_modules` path.
 */
export function buildCapDestinationCsrfTokenFetcher(
    destination: string,
    destinationOptions: Record<string, unknown>,
    csrfUrl: string,
    method: CsrfPreflightMethod = "get",
    overrides: CapDestinationTokenFetcherOverrides = {}
): CsrfTokenFetcher {
    const destinationRef = { destinationName: destination, ...destinationOptions }
    const nativeMethod: "GET" | "HEAD" = method === "head" ? "HEAD" : "GET"

    return async () => {
        const internals = "capInternals" in overrides ? overrides.capInternals ?? null : resolveCapInternals()
        // No way to ask CAP - default to trying the Cloud SDK first, same as when internals resolve fine and it turns out to be installed.
        const useCloudSdk = internals ? internals.shouldUseCloudSdk(destination) : true

        if (useCloudSdk) {
            const cloudSdkFetch = "cloudSdkFetch" in overrides ? overrides.cloudSdkFetch ?? null : resolveCloudSdkExecutor()
            if (cloudSdkFetch) {
                const response = await cloudSdkFetch(destinationRef, { method, url: csrfUrl, headers: { [CSRF_TOKEN_HEADER]: "Fetch" } })
                return tokenFrom(response.headers, response.status, csrfUrl)
            }
        }

        if (internals) {
            const response = await internals.nativeFetch(destinationRef, { method: nativeMethod, url: csrfUrl, headers: { [CSRF_TOKEN_HEADER]: "Fetch" } })
            return tokenFrom(response.headers, response.status, csrfUrl)
        }

        throw new Error(`Could not fetch a CSRF token from ${csrfUrl}: neither the SAP Cloud SDK nor @sap/cds's native fetch client is available.`)
    }
}
