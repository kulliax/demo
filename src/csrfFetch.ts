import { CSRF_TOKEN_HEADER, CsrfToken, CsrfTokenCache, CsrfTokenFetcher, isCsrfRequiredRejection, missingCsrfTokenError, toCookieHeader } from "./CsrfTokenCache"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"])

/**
 * Native-`fetch` token fetcher - kept deliberately separate from {@link buildCapDestinationCsrfTokenFetcher}
 * (see that module for why): this one has no SAP Cloud SDK dependency at all and works with any
 * plain HTTP(S) endpoint reachable via Node's global `fetch`.
 *
 * Builds a {@link CsrfTokenFetcher}: a GET request carrying `x-csrf-token: Fetch` against `url`,
 * answered with the token in the same response header and the session cookie(s) needed to present
 * it back on the next write. GET (not HEAD) is used because it is the verb every SAP gateway/OData
 * implementation is guaranteed to answer a CSRF-fetch on, including services that don't implement HEAD.
 */
export function buildCsrfTokenFetcher(url: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): CsrfTokenFetcher {
    return async () => {
        const response = await fetchImpl(url, {
            ...init,
            method: "GET",
            headers: { ...init.headers, [CSRF_TOKEN_HEADER]: "Fetch" }
        })

        const token = response.headers.get(CSRF_TOKEN_HEADER)
        if (!response.ok || !token)
            throw missingCsrfTokenError(url, response.status)

        return { token, cookies: response.headers.getSetCookie?.() ?? [] }
    }
}

function withCsrfHeaders(init: RequestInit | undefined, token: CsrfToken): Headers {
    const headers = new Headers(init?.headers)
    headers.set(CSRF_TOKEN_HEADER, token.token)
    const cookieHeader = toCookieHeader(token.cookies)
    if (cookieHeader) headers.set("cookie", cookieHeader)
    return headers
}

function isCsrfRejection(response: Response): boolean {
    return isCsrfRequiredRejection(response.status, response.headers.get(CSRF_TOKEN_HEADER))
}

/**
 * Wraps a fetch-compatible function so every non-safe request is transparently armed with the
 * cached CSRF token, and retried exactly once - with a freshly fetched token - if the backend
 * rejects it as expired (`403` + `x-csrf-token: Required`). Safe methods pass through untouched.
 *
 * This is the piece that makes the cache usable with plain native `fetch` calls, independent of
 * any CAP/Cloud SDK service - see {@link buildCsrfTokenFetcher} for a matching token fetcher, and
 * `attachCsrfCache` for the equivalent wiring against a `cds.RemoteService`.
 */
export function createCsrfFetch(cache: CsrfTokenCache, fetchImpl: typeof fetch = fetch): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase()
        if (SAFE_METHODS.has(method))
            return fetchImpl(input, init)

        const token = await cache.getToken()
        const response = await fetchImpl(input, { ...init, method, headers: withCsrfHeaders(init, token) })
        if (!isCsrfRejection(response))
            return response

        cache.invalidate()
        const freshToken = await cache.getToken()
        return fetchImpl(input, { ...init, method, headers: withCsrfHeaders(init, freshToken) })
    }) as typeof fetch
}
