import cds from "@sap/cds"
import { CsrfTokenCache } from "./CsrfTokenCache"

const LOG = cds.log("csrf-cache")

/**
 * Everything that has to match before two remote services may present the *same* CSRF token.
 *
 * An S/4 CSRF token is bound to the HTTP session behind the destination, not to the OData service
 * path it was fetched from - so a token fetched for `zsd_o2c_order_processing` is equally valid on
 * `api_purchaseorder_2` as long as both go to the same system, through the same destination, with
 * the same destination resolution (`destinationOptions` decide *which* concrete destination, and
 * therefore which backend user/session, a name resolves to - a different `selectionStrategy` or a
 * different `jwt` can mean a different session entirely, so they are part of the identity here).
 *
 * `group` narrows that further, for the case where two services share a destination but must not
 * share a token (different backend clients behind one destination name, or simply to keep one
 * service's token isolated while the rest share one).
 */
export type SharedCsrfCacheScope = {
    destination: string
    destinationOptions?: Record<string, unknown>
    group?: string
}

type Registration = {
    cache: CsrfTokenCache
    /** The service that created the cache - its `csrf` settings are the ones the shared cache runs with. */
    owner: string
    /** Every service using this cache, owner first, for logging and introspection. */
    members: string[]
    /** The owner's token-fetch settings, so a joining service configured differently can be reported. */
    settings: string
}

const registry = new Map<string, Registration>()

/** `JSON.stringify` with sorted keys, so two equal `destinationOptions` objects can't produce two different keys just because they were written in a different order. */
function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
    const entries = Object.keys(value as Record<string, unknown>).sort()
        .map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    return `{${entries.join(",")}}`
}

/** The identity of a shared cache - see {@link SharedCsrfCacheScope} for why each part is in it. */
export function sharedCsrfCacheKey(scope: SharedCsrfCacheScope): string {
    return `${scope.destination}::${stableStringify(scope.destinationOptions ?? {})}::${scope.group ?? ""}`
}

export type SharedCsrfCache = {
    cache: CsrfTokenCache
    key: string
    /** `true` if an existing cache was joined, `false` if this call created it. */
    joined: boolean
    /** The service that created the cache (the caller itself when `joined` is `false`). */
    owner: string
}

/**
 * Returns the {@link CsrfTokenCache} for `scope`, creating it via `create` on first use and handing
 * the very same instance to every later caller with the same scope. That is what lets several
 * remote services on one destination fetch a single token instead of one each - and it also means
 * an `invalidate()` after a rejected token (from *any* of them) refreshes the token for all of
 * them at once.
 *
 * The first service in wins: the shared cache keeps fetching from that service's `csrf.url`, with
 * its method and validity. A service joining with different settings is served the existing cache
 * and warned about, rather than silently getting a second one - two caches on one destination is
 * exactly what sharing was turned on to avoid.
 */
export function acquireSharedCsrfCache(
    scope: SharedCsrfCacheScope,
    member: string,
    settings: string,
    create: () => CsrfTokenCache
): SharedCsrfCache {
    const key = sharedCsrfCacheKey(scope)
    const existing = registry.get(key)

    if (existing) {
        if (!existing.members.includes(member)) existing.members.push(member)
        if (existing.settings !== settings)
            LOG.warn(`service '${member}' joins the shared csrf token cache of destination '${scope.destination}' with different settings (${settings}) `
                + `than its owner '${existing.owner}' (${existing.settings}); the owner's settings stay in effect`)
        return { cache: existing.cache, key, joined: true, owner: existing.owner }
    }

    const registration: Registration = { cache: create(), owner: member, members: [member], settings }
    registry.set(key, registration)
    return { cache: registration.cache, key, joined: false, owner: member }
}

/** The services sharing the cache under `key`, owner first - for diagnostics and tests. */
export function sharedCsrfCacheMembers(key: string): string[] {
    return [...registry.get(key)?.members ?? []]
}

/** Disposes every shared cache (stopping its refresh timer) and empties the registry. For tests and for a clean shutdown/restart of the server process. */
export function resetSharedCsrfCaches(): void {
    for (const { cache } of registry.values()) cache.dispose()
    registry.clear()
}
