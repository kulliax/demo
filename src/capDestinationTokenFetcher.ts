import cds from "@sap/cds"
import { ClientResponse, DestinationRef, HttpExecutor, resolveExecutor, toDestinationRef } from "./capClients"
import { CSRF_TOKEN_HEADER, CsrfToken, CsrfTokenFetcher, missingCsrfTokenError } from "./CsrfTokenCache"

const LOG = cds.log("csrf-cache")

/** Verb for the token preflight - only `get`/`head` make sense for one, and CAP's own `csrf.method` allows exactly these. */
export type CsrfPreflightMethod = "get" | "head"

/** One preflight attempt against a given URL, for {@link withSlashRetry} to repeat. */
type PreflightAttempt = (url: string) => Promise<CsrfToken>

/** Response headers are lowercased by both clients, but the Cloud SDK's own csrf middleware still reads them case-insensitively - so does this. */
function headerValue(headers: Record<string, unknown>, name: string): unknown {
    if (name in headers) return headers[name]
    const key = Object.keys(headers).find(header => header.toLowerCase() === name)
    return key === undefined ? undefined : headers[key]
}

function cookiesFrom(setCookie: unknown): string[] {
    return [setCookie].flat().filter((cookie): cookie is string => typeof cookie === "string")
}

/**
 * Reads token and session cookie(s) out of a preflight response. The status only feeds the error
 * message: a token is accepted whatever it is, because some SAP backends answer the preflight with
 * a 4xx/5xx and still hand out a usable one - which CAP's own client (`_csrfPreflight` in
 * `fetchClient.js`) and the Cloud SDK's csrf middleware both take from there on purpose. Only a
 * response without any token is an error.
 */
function tokenFrom(response: ClientResponse, csrfUrl: string): CsrfToken {
    const token = headerValue(response.headers, CSRF_TOKEN_HEADER)
    if (typeof token !== "string" || !token) throw missingCsrfTokenError(csrfUrl, response.status)
    return { token, cookies: cookiesFrom(headerValue(response.headers, "set-cookie")) }
}

/** A non-2xx preflight arrives as a thrown error carrying the response (`if (!response.ok) throw` in CAP's client, axios's default `validateStatus` in the Cloud SDK's) - which may still hold the token. */
function responseOf(error: unknown): ClientResponse | undefined {
    const response = (error as { response?: { status?: number, headers?: Record<string, unknown> } })?.response
    if (!response?.headers) return undefined
    return { status: response.status ?? 0, headers: response.headers }
}

/** The correlation headers CAP puts on every remote request (`Service.js`), so a token fetch can be traced together with the request that triggered it. A background refresh has no request context and sends none. */
function correlationHeaders(): Record<string, string> {
    const correlationId = cds.context?.id
    return correlationId ? { "x-correlation-id": correlationId, "x-correlationid": correlationId } : {}
}

/** The preflight itself - written once, for whichever client `capClients.ts` picked. */
async function preflight(execute: HttpExecutor, destinationRef: DestinationRef, method: string, url: string): Promise<CsrfToken> {
    const requestConfig = { method, url, headers: { ...correlationHeaders(), [CSRF_TOKEN_HEADER]: "Fetch" } }

    try {
        return tokenFrom(await execute(destinationRef, requestConfig), url)
    } catch (error) {
        const rejected = responseOf(error)
        if (!rejected || !headerValue(rejected.headers, CSRF_TOKEN_HEADER)) throw error
        return tokenFrom(rejected, url)
    }
}

/**
 * S/4 answers a preflight whose URL is missing the trailing slash with a redirect (axios#3369), so
 * CAP's own client (`_fetchCsrfToken`) and the Cloud SDK's csrf middleware (`makeCsrfRequests`)
 * both try with the slash first and then without it. A fetcher that only ever tried one of the two
 * would fail against exactly the systems this plugin exists for, so this does the same.
 */
async function withSlashRetry(attempt: PreflightAttempt, csrfUrl: string): Promise<CsrfToken> {
    const withSlash = csrfUrl.endsWith("/") ? csrfUrl : `${csrfUrl}/`

    try {
        return await attempt(withSlash)
    } catch (error) {
        LOG.debug(`csrf token preflight against '${withSlash}' failed, retrying without the trailing slash`, error)
        return attempt(csrfUrl.replace(/\/+$/, ""))
    }
}

/**
 * Builds a {@link CsrfTokenFetcher} for a connected `cds.RemoteService`'s destination. The client is
 * neither hardcoded here nor chosen here: `capClients.ts` asks CAP's own `shouldUseCloudSdk()` and
 * hands back the SAP Cloud SDK or CAP's own native-fetch client, whichever `cds.RemoteService` would
 * use for a real request against that destination - see that module for why that decision must
 * neither be hardcoded nor rebuilt, and why the Cloud SDK stays optional.
 */
export function buildCapDestinationCsrfTokenFetcher(
    destination: DestinationRef,
    destinationOptions: Record<string, unknown>,
    csrfUrl: string,
    method: CsrfPreflightMethod = "get"
): CsrfTokenFetcher {
    const destinationRef = toDestinationRef(destination, destinationOptions)
    // Uppercase for both clients: CAP's native client compares `method` against 'GET'/'HEAD'
    // literally, and axios (and with it the Cloud SDK) is case-insensitive - so one spelling serves both.
    const httpMethod = method.toUpperCase()

    return async () => {
        const execute = resolveExecutor(destination)
        return await withSlashRetry(url => preflight(execute, destinationRef, httpMethod, url), csrfUrl)
    }
}
