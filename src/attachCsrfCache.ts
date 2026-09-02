import cds from "@sap/cds"
import { CSRF_TOKEN_HEADER, CsrfTokenCache, CsrfTokenCacheOptions, isCsrfRequiredRejection, toCookieHeader } from "./CsrfTokenCache"
import { buildCapDestinationCsrfTokenFetcher, CsrfPreflightMethod } from "./capDestinationTokenFetcher"
import { acquireSharedCsrfCache } from "./sharedCsrfCaches"

const LOG = cds.log("csrf-cache")
const SAFE_METHODS = new Set(["GET", "HEAD"])

/** Environment-wide default for `csrf.share`, so all services of a destination can be switched to one token without touching each of them. */
const DEFAULT_SHARE = /^(true|1|yes|on)$/i.test(process.env.csrf_token_share ?? "")

/**
 * The `csrf` config CAP itself reads (`this.csrf = this.options.csrf`, a sibling of `credentials`
 * in `.cdsrc.json` - NOT nested inside it), extended with this plugin's own settings
 * (`cache`, `validitySeconds`, `autoRefresh`).
 */
type CsrfConfig = {
    url?: string
    /** Verb for the token-fetch preflight. Already a CAP-respected field (defaults to `head` if unset); this plugin defaults to `get` for broader OData compatibility. */
    method?: string
    /** Set to `false` to leave this service on CAP's default per-request CSRF handling instead of caching. Defaults to `true`. */
    cache?: boolean
    /** How long a fetched token stays valid, in seconds, before this plugin proactively re-fetches it. Falls back to `CsrfTokenCacheOptions`/the env-var default when unset. */
    validitySeconds?: number
    /** Set to `false` to only fetch a replacement token lazily, on the first request after it went stale, instead of proactively in the background. Defaults to `true`. */
    autoRefresh?: boolean
    /**
     * Share one cached token with every other service configured for the same destination (and the
     * same `destinationOptions`) instead of caching one token per service - see
     * `SharedCsrfCacheScope` in `sharedCsrfCaches.ts` for why that is safe on S/4 and what exactly
     * has to match. A string instead of `true` names a share group, so services on one destination
     * can be split into separate shared tokens; only services naming the same group share one. Defaults to the `csrf_token_share` environment variable,
     * i.e. to `false`.
     */
    share?: boolean | string
}

type ShareSetting = { enabled: boolean, group?: string }

/** `csrf.share` as a boolean plus an optional group name; an empty/whitespace-only string is treated as a plain `true`, not as a group called "". */
function resolveShare(share: boolean | string | undefined): ShareSetting {
    if (share === undefined) return { enabled: DEFAULT_SHARE }
    if (typeof share === "string") {
        const group = share.trim()
        return group ? { enabled: true, group } : { enabled: true }
    }
    return { enabled: share }
}

/**
 * Programmatic overrides for {@link attachCsrfCache} - the cache's own timing options, plus this
 * plugin's `share` switch, which the `csrf` config expresses as `csrf.share`.
 */
export type AttachCsrfCacheOptions = CsrfTokenCacheOptions & {
    /** Overrides `csrf.share` for this service: share the destination's token cache (optionally within the named group) instead of caching a token of its own. */
    share?: boolean | string
}

/** The owner settings a shared cache actually runs with, so a service joining with different ones can be named in the warning. */
function describeSettings(csrfUrl: string, method: CsrfPreflightMethod, csrfConfig: CsrfConfig): string {
    return `url=${csrfUrl}, method=${method}, validitySeconds=${csrfConfig.validitySeconds ?? "default"}, autoRefresh=${csrfConfig.autoRefresh ?? "default"}`
}

type RemoteServiceInternals = {
    destination?: string
    destinationOptions?: Record<string, unknown>
    csrf?: boolean | CsrfConfig
    path?: string
}

/** `csrf: true` (zapi_sales_order_srv) has no explicit fetch URL - the service's own root path is used, matching CAP's own default. */
function resolveCsrfConfig(srv: RemoteServiceInternals): CsrfConfig | undefined {
    if (srv.csrf === true) return { url: srv.path }
    if (srv.csrf && typeof srv.csrf === "object") return srv.csrf
    return undefined
}

/** Only `get`/`head` make sense for a CSRF preflight; anything else falls back to `get`, same as an unset `csrf.method`. */
function normalizeCsrfMethod(method: string | undefined): CsrfPreflightMethod {
    return method?.toLowerCase() === "head" ? "head" : "get"
}

function isCsrfRejection(error: unknown): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (error as any)?.reason?.response
    const header = response?.headers?.[CSRF_TOKEN_HEADER] ?? response?.headers?.["X-CSRF-Token"]
    return isCsrfRequiredRejection(response?.status, header)
}

/**
 * Attaches a {@link CsrfTokenCache} to a connected `cds.RemoteService`: caches the CSRF token
 * instead of letting CAP fetch a fresh one on every write, and retries once, with a fresh token, if
 * the backend ever rejects the cached one as expired.
 *
 * Once attached, this cache becomes the sole owner of CSRF handling for the service: `srv.csrf` is
 * cleared (after its `url`/`method`/etc. have been read) so CAP's own built-in per-request csrf
 * middleware never runs for it. That middleware would otherwise still fire on every write regardless
 * of the token this cache already put on the request - neither the SAP Cloud SDK nor (confirmed
 * against `@sap/cds/libx/_runtime/remote/utils/fetchClient.js`) CAP's native-fetch client skips its
 * own preflight just because `x-csrf-token` is already present. Left enabled, that preflight not
 * only re-fetches (and often re-authenticates) a token this cache already has, it targets the
 * request's own URL with a trailing slash (an S/4 redirect workaround) - against a plain CAP OData
 * service that resolves to `<Entity>/`, which CAP's own generic parser can reject outright (e.g. a
 * UUID-keyed entity like `Orders/` gets read as an incomplete key with an empty value).
 *
 * A service without a destination, without any `csrf` configuration, or with `csrf.cache: false`
 * (e.g. a `--with-mocks` stand-in used in dev/test) is left untouched - there is nothing to cache a
 * token for, or the config explicitly opted out; CAP's own per-request csrf handling stays in charge
 * for it, unchanged. Called automatically by this package's `cds-plugin.js` for every served remote
 * service; only call it directly for a service the plugin's auto-discovery does not reach (e.g. a
 * service served in a separate process).
 *
 * With `csrf.share` (or `options.share`) turned on, the service does not get a cache of its own but
 * joins the one shared by every other service on the same destination - one token fetch for all of
 * them instead of one each; see {@link acquireSharedCsrfCache}.
 */
export function attachCsrfCache(srv: cds.RemoteService, options: AttachCsrfCacheOptions = {}): CsrfTokenCache | undefined {
    const { share: shareOverride, ...cacheOptions } = options
    const internals = srv as unknown as RemoteServiceInternals
    const csrfConfig = resolveCsrfConfig(internals)
    if (!internals.destination || !csrfConfig?.url || csrfConfig.cache === false) {
        LOG.debug(`service '${srv.name}' has no cacheable destination-backed csrf configuration, skipping csrf token cache`)
        return undefined
    }

    const destination = internals.destination
    const destinationOptions = internals.destinationOptions ?? {}
    const csrfUrl = csrfConfig.url
    const method = normalizeCsrfMethod(csrfConfig.method)
    // Built inside `createCache` so a service that only joins an existing shared cache never
    // constructs a token fetcher it would have no use for.
    const createCache = () => new CsrfTokenCache(
        buildCapDestinationCsrfTokenFetcher(destination, destinationOptions, csrfUrl, method), {
            validitySeconds: csrfConfig.validitySeconds,
            autoRefresh: csrfConfig.autoRefresh,
            ...cacheOptions
        })

    const share = resolveShare(shareOverride ?? csrfConfig.share)
    const shared = share.enabled
        ? acquireSharedCsrfCache({ destination, destinationOptions, group: share.group },
            srv.name, describeSettings(csrfUrl, method, csrfConfig), createCache)
        : undefined
    const cache = shared?.cache ?? createCache()

    // This cache now owns csrf handling for the service - see the function doc for why CAP's own
    // built-in per-request preflight (which does not check for an already-present x-csrf-token
    // header before running, on the SAP Cloud SDK or native-fetch client alike) must not also run.
    internals.csrf = undefined

    srv.before("*", async (req: cds.Request) => {
        if (SAFE_METHODS.has((req.method ?? "").toUpperCase())) return

        try {
            const token = await cache.getToken()
            req.headers ??= {}
            req.headers[CSRF_TOKEN_HEADER] = token.token
            const cookieHeader = toCookieHeader(token.cookies)
            if (cookieHeader) req.headers["cookie"] = cookieHeader
        } catch (error) {
            LOG.warn("could not obtain a cached csrf token, letting the request go through without one", error)
        }
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const send = srv.send.bind(srv) as any
    srv.send = (async (...args: unknown[]) => {
        try {
            return await send(...args)
        } catch (error) {
            if (!isCsrfRejection(error)) throw error
            LOG.warn(`service '${srv.name}' rejected the cached csrf token as expired, refreshing and retrying once`)
            cache.invalidate()
            return await send(...args)
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any

    if (!shared) LOG.info(`csrf token cache attached to service '${srv.name}'`)
    else if (shared.joined) LOG.info(`service '${srv.name}' joined the csrf token cache shared for destination '${destination}' (created by '${shared.owner}')`)
    else LOG.info(`csrf token cache attached to service '${srv.name}', shared with every other service on destination '${destination}'`)
    return cache
}
