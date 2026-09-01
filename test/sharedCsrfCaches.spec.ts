import { afterEach, describe, expect, it, vi } from "vitest"
import { CsrfTokenCache } from "../src/CsrfTokenCache"
import { acquireSharedCsrfCache, resetSharedCsrfCaches, sharedCsrfCacheKey, sharedCsrfCacheMembers } from "../src/sharedCsrfCaches"

const SETTINGS = "url=/service/, method=get"

function newCache(): CsrfTokenCache {
    return new CsrfTokenCache(vi.fn().mockResolvedValue({ token: "t1", cookies: [] }))
}

afterEach(() => {
    resetSharedCsrfCaches()
})

describe("sharedCsrfCacheKey", () => {
    it("is independent of the key order inside destinationOptions", () => {
        const one = sharedCsrfCacheKey({ destination: "s4-o2c-100", destinationOptions: { useCache: true, selectionStrategy: "alwaysProvider" } })
        const other = sharedCsrfCacheKey({ destination: "s4-o2c-100", destinationOptions: { selectionStrategy: "alwaysProvider", useCache: true } })

        expect(one).toBe(other)
    })

    it("separates destinations, differing destinationOptions and groups", () => {
        const base = { destination: "s4-o2c-100", destinationOptions: { useCache: true } }

        const keys = new Set([
            sharedCsrfCacheKey(base),
            sharedCsrfCacheKey({ ...base, destination: "s4-100-pls" }),
            sharedCsrfCacheKey({ ...base, destinationOptions: { useCache: false } }),
            sharedCsrfCacheKey({ ...base, group: "writes" })
        ])

        expect(keys.size).toBe(4)
    })
})

describe("acquireSharedCsrfCache", () => {
    it("creates the cache once and hands the same instance to every later service on that destination", () => {
        const scope = { destination: "s4-o2c-100", destinationOptions: { useCache: true } }
        const create = vi.fn(newCache)

        const first = acquireSharedCsrfCache(scope, "zsd_o2c_order_processing", SETTINGS, create)
        const second = acquireSharedCsrfCache(scope, "api_purchaseorder_2", SETTINGS, create)

        expect(create).toHaveBeenCalledOnce()
        expect(second.cache).toBe(first.cache)
        expect(first.joined).toBe(false)
        expect(second.joined).toBe(true)
        expect(second.owner).toBe("zsd_o2c_order_processing")
        expect(sharedCsrfCacheMembers(first.key)).toEqual(["zsd_o2c_order_processing", "api_purchaseorder_2"])
    })

    it("keeps caches apart for different destinations", () => {
        const create = vi.fn(newCache)

        const one = acquireSharedCsrfCache({ destination: "s4-o2c-100" }, "a", SETTINGS, create)
        const other = acquireSharedCsrfCache({ destination: "s4-100-pls" }, "b", SETTINGS, create)

        expect(create).toHaveBeenCalledTimes(2)
        expect(other.cache).not.toBe(one.cache)
    })

    it("keeps caches apart for different groups on one destination", () => {
        const create = vi.fn(newCache)

        const one = acquireSharedCsrfCache({ destination: "s4-o2c-100", group: "reads" }, "a", SETTINGS, create)
        const other = acquireSharedCsrfCache({ destination: "s4-o2c-100", group: "writes" }, "b", SETTINGS, create)

        expect(create).toHaveBeenCalledTimes(2)
        expect(other.cache).not.toBe(one.cache)
    })

    it("serves the existing cache to a service configured differently instead of creating a second one", () => {
        const scope = { destination: "s4-o2c-100" }
        const create = vi.fn(newCache)

        const owner = acquireSharedCsrfCache(scope, "a", "url=/a/, method=get", create)
        const joiner = acquireSharedCsrfCache(scope, "b", "url=/b/, method=head", create)

        expect(create).toHaveBeenCalledOnce()
        expect(joiner.cache).toBe(owner.cache)
        expect(joiner.owner).toBe("a")
    })

    it("registers a service only once, even if it is attached twice", () => {
        const scope = { destination: "s4-o2c-100" }

        const { key } = acquireSharedCsrfCache(scope, "a", SETTINGS, newCache)
        acquireSharedCsrfCache(scope, "a", SETTINGS, newCache)

        expect(sharedCsrfCacheMembers(key)).toEqual(["a"])
    })

    it("reports no members for an unknown key", () => {
        expect(sharedCsrfCacheMembers("nope")).toEqual([])
    })
})

describe("resetSharedCsrfCaches", () => {
    it("disposes every registered cache and empties the registry", () => {
        const cache = newCache()
        const dispose = vi.spyOn(cache, "dispose")
        const { key } = acquireSharedCsrfCache({ destination: "s4-o2c-100" }, "a", SETTINGS, () => cache)

        resetSharedCsrfCaches()

        expect(dispose).toHaveBeenCalledOnce()
        expect(sharedCsrfCacheMembers(key)).toEqual([])
        // The next acquire starts from scratch rather than handing out the disposed cache.
        expect(acquireSharedCsrfCache({ destination: "s4-o2c-100" }, "a", SETTINGS, newCache).joined).toBe(false)
    })
})
