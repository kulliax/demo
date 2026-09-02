import cds from "@sap/cds"

export type CsrfToken = {
    token: string
    cookies: string[]
}

export type CsrfTokenFetcher = () => Promise<CsrfToken>

/**
 * A token as the cache serves it: with the `Cookie` header for it already assembled, so that
 * string is built once per fetched token instead of once per outgoing request.
 */
export type CachedCsrfToken = CsrfToken & { cookieHeader?: string }

export type CsrfTokenCacheOptions = {
    /** How long a token stays valid on the backend, in seconds. S/4 defaults to 1800 (30 minutes). */
    validitySeconds?: number
    /** How long before `validitySeconds` runs out the cache proactively re-fetches in the background. */
    bufferSeconds?: number
    /** Proactively re-fetch `bufferSeconds` before expiry instead of only fetching lazily on demand. Defaults to `true`. */
    autoRefresh?: boolean
}

type CachedToken = CachedCsrfToken & { expiresAt: number }

/** Shared by every token-fetch implementation and by `attachCsrfCache`'s 403 detection, so the header name and its "Required" rejection value are spelled out exactly once. */
export const CSRF_TOKEN_HEADER = "x-csrf-token"

/** A cookie's path/domain/etc. attributes are not valid in a request `Cookie` header - only `name=value` survives. */
export function toCookieHeader(cookies: string[]): string | undefined {
    return cookies.length ? cookies.map(cookie => cookie.split(";")[0]).join("; ") : undefined
}

/** True for the exact rejection S/4 (and CAP itself) use to signal an expired/invalid token: `403` + `x-csrf-token: Required`. */
export function isCsrfRequiredRejection(status: number | undefined, csrfTokenHeaderValue: string | null | undefined): boolean {
    return status === 403 && csrfTokenHeaderValue?.toLowerCase() === "required"
}

/** Thrown by every token-fetch implementation when the preflight didn't come back with a usable token - one wording, so the two call sites can't drift apart. */
export function missingCsrfTokenError(url: string, status: number): Error {
    return new Error(`Could not obtain a CSRF token from ${url} (HTTP ${status})`)
}

const DEFAULT_VALIDITY_SECONDS = Number(process.env.csrf_token_validity_seconds ?? 1800)
const DEFAULT_BUFFER_SECONDS = Number(process.env.csrf_token_buffer_seconds ?? 60)

/**
 * Caches a CSRF token obtained from `fetchToken` and proactively re-fetches it `bufferSeconds`
 * before `validitySeconds` (the backend-side lifetime, 30 minutes on S/4) runs out - the buffer is
 * only a safety margin for *when* to refresh early, not a cut into the token's usable lifetime:
 * `getToken()` keeps serving the last known token up to the full `validitySeconds`, even if a
 * background refresh attempt failed, and only fetches synchronously once that hard limit is hit.
 * Concurrent `getToken()` calls share a single in-flight fetch.
 *
 * Framework-agnostic by design: the cache itself has no HTTP dependency at all, it only needs an
 * async `fetchToken()`. {@link buildCapDestinationCsrfTokenFetcher} is the implementation this
 * package ships, for a connected `cds.RemoteService`'s destination.
 */
export class CsrfTokenCache {
    private readonly log: ReturnType<typeof cds.log>
    private readonly validitySeconds: number
    private readonly bufferSeconds: number
    private readonly autoRefresh: boolean

    private readonly fetchToken: CsrfTokenFetcher
    private cached?: CachedToken
    private pending?: Promise<CsrfToken>
    private refreshTimer?: ReturnType<typeof setTimeout>

    constructor(fetchToken: CsrfTokenFetcher, options: CsrfTokenCacheOptions = {}) {
        this.fetchToken = fetchToken
        this.validitySeconds = options.validitySeconds ?? DEFAULT_VALIDITY_SECONDS
        this.bufferSeconds = options.bufferSeconds ?? DEFAULT_BUFFER_SECONDS
        this.autoRefresh = options.autoRefresh ?? true
        this.log = cds.log("csrf-cache")

        if (this.bufferSeconds < 0 || this.bufferSeconds >= this.validitySeconds)
            throw new Error(`csrf token buffer (${this.bufferSeconds}s) must be >= 0 and smaller than its validity (${this.validitySeconds}s)`)
    }

    /** Returns a valid token, fetching (and caching) one first if necessary - and logs which of the two it was, so the cache's effect is visible in the request log. */
    async getToken(): Promise<CachedCsrfToken> {
        if (this.cached && this.cached.expiresAt > Date.now()) {
            this.log.debug(`csrf token taken from cache, valid until ${new Date(this.cached.expiresAt).toISOString()}`)
            return this.cached
        }
        return this.triggerRefresh()
    }

    /** Drops the cached token, forcing the next `getToken()` call to fetch a fresh one. */
    invalidate(): void {
        this.cached = undefined
        this.clearRefreshTimer()
    }

    /** Clears the proactive refresh timer. Call on shutdown/in tests so the process/test can exit cleanly. */
    dispose(): void {
        this.clearRefreshTimer()
    }

    /** Shared by `getToken()` and the proactive refresh timer, so a request racing the timer joins the same fetch - and logs whether it started that fetch or joined a running one. */
    private triggerRefresh(): Promise<CachedCsrfToken> {
        if (this.pending) {
            this.log.debug("csrf token fetch already in flight, joining it")
            return this.pending
        }

        this.log.debug("requesting a new csrf token")
        return this.pending = this.refresh().finally(() => { this.pending = undefined })
    }

    private async refresh(): Promise<CachedCsrfToken> {
        const fetchedAt = Date.now()
        const token = await this.fetchToken()
        this.cached = { ...token, cookieHeader: toCookieHeader(token.cookies), expiresAt: fetchedAt + this.validitySeconds * 1000 }
        this.log.info(`fetched a new csrf token, valid until ${new Date(this.cached.expiresAt).toISOString()}`)
        this.scheduleRefresh(fetchedAt)
        return this.cached
    }

    private scheduleRefresh(fetchedAt: number): void {
        this.clearRefreshTimer()
        if (!this.autoRefresh) return

        const refreshAt = fetchedAt + (this.validitySeconds - this.bufferSeconds) * 1000
        this.refreshTimer = setTimeout(() => {
            this.triggerRefresh().catch(error =>
                this.log.warn("proactive csrf token refresh failed, keeping the last known token until it expires", error))
        }, Math.max(0, refreshAt - Date.now()))
        this.refreshTimer.unref?.()
    }

    private clearRefreshTimer(): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer)
        this.refreshTimer = undefined
    }
}
