import cds from "@sap/cds"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CsrfTokenCache } from "../src/CsrfTokenCache"

const token = (value: string) => ({ token: value, cookies: [`sap-usercontext=${value}; path=/`] })

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe("CsrfTokenCache", () => {
    it("fetches a token once and serves it from cache on subsequent calls", async () => {
        const fetchToken = vi.fn().mockResolvedValue(token("t1"))
        const cache = new CsrfTokenCache(fetchToken, { validitySeconds: 1800, bufferSeconds: 60 })

        const first = await cache.getToken()
        const second = await cache.getToken()

        expect(first).toMatchObject(token("t1"))
        expect(second).toMatchObject(token("t1"))
        expect(fetchToken).toHaveBeenCalledOnce()
        cache.dispose()
    })

    it("dedupes concurrent getToken() calls into a single fetch", async () => {
        const { promise, resolve: resolveFetch } = Promise.withResolvers<ReturnType<typeof token>>()
        const fetchToken = vi.fn().mockImplementation(() => promise)
        const cache = new CsrfTokenCache(fetchToken, { validitySeconds: 1800, bufferSeconds: 60 })

        const calls = [cache.getToken(), cache.getToken(), cache.getToken()]
        resolveFetch(token("t1"))
        const results = await Promise.all(calls)

        expect(fetchToken).toHaveBeenCalledOnce()
        results.forEach(result => expect(result).toMatchObject(token("t1")))
        cache.dispose()
    })

    it("keeps serving the cached token until its hard validity runs out, then refetches", async () => {
        const fetchToken = vi.fn().mockResolvedValueOnce(token("t1")).mockResolvedValueOnce(token("t2"))
        const cache = new CsrfTokenCache(fetchToken, { validitySeconds: 100, bufferSeconds: 10, autoRefresh: false })

        expect(await cache.getToken()).toMatchObject(token("t1"))

        // The buffer only moves the *proactive* refresh point earlier (irrelevant here since
        // autoRefresh is off) - it does not shrink how long getToken() itself keeps serving the token.
        vi.advanceTimersByTime(99_000)
        expect(await cache.getToken()).toMatchObject(token("t1"))
        expect(fetchToken).toHaveBeenCalledOnce()

        // Past the full validity: a fresh token is fetched.
        vi.advanceTimersByTime(2_000)
        expect(await cache.getToken()).toMatchObject(token("t2"))
        expect(fetchToken).toHaveBeenCalledTimes(2)
        cache.dispose()
    })

    it("proactively refreshes in the background before the cached token goes stale", async () => {
        const fetchToken = vi.fn().mockResolvedValueOnce(token("t1")).mockResolvedValueOnce(token("t2"))
        const cache = new CsrfTokenCache(fetchToken, { validitySeconds: 100, bufferSeconds: 10 })

        await cache.getToken()
        expect(fetchToken).toHaveBeenCalledOnce()

        // The refresh timer fires at validitySeconds - bufferSeconds = 90s, with no request in flight.
        await vi.advanceTimersByTimeAsync(90_000)

        expect(fetchToken).toHaveBeenCalledTimes(2)
        expect(await cache.getToken()).toMatchObject(token("t2"))
        cache.dispose()
    })

    it("does not schedule a background refresh when autoRefresh is disabled", async () => {
        const fetchToken = vi.fn().mockResolvedValue(token("t1"))
        const cache = new CsrfTokenCache(fetchToken, { validitySeconds: 100, bufferSeconds: 10, autoRefresh: false })

        await cache.getToken()
        await vi.advanceTimersByTimeAsync(200_000)

        expect(fetchToken).toHaveBeenCalledOnce()
        cache.dispose()
    })

    it("keeps serving the last known token when a proactive background refresh fails", async () => {
        const fetchToken = vi.fn()
            .mockResolvedValueOnce(token("t1"))
            .mockRejectedValueOnce(new Error("backend unavailable"))
        const cache = new CsrfTokenCache(fetchToken, { validitySeconds: 100, bufferSeconds: 10 })

        await cache.getToken()
        await vi.advanceTimersByTimeAsync(90_000)

        expect(fetchToken).toHaveBeenCalledTimes(2)
        // The failed background refresh must not have cleared the still-valid cached token.
        expect(await cache.getToken()).toMatchObject(token("t1"))
        cache.dispose()
    })

    it("invalidate() forces the next getToken() call to fetch a fresh token", async () => {
        const fetchToken = vi.fn().mockResolvedValueOnce(token("t1")).mockResolvedValueOnce(token("t2"))
        const cache = new CsrfTokenCache(fetchToken, { validitySeconds: 1800, bufferSeconds: 60 })

        expect(await cache.getToken()).toMatchObject(token("t1"))
        cache.invalidate()
        expect(await cache.getToken()).toMatchObject(token("t2"))
        expect(fetchToken).toHaveBeenCalledTimes(2)
        cache.dispose()
    })

    it("propagates a fetch failure and retries on the next call instead of caching it", async () => {
        const fetchToken = vi.fn().mockRejectedValueOnce(new Error("network error")).mockResolvedValueOnce(token("t1"))
        const cache = new CsrfTokenCache(fetchToken, { validitySeconds: 1800, bufferSeconds: 60 })

        await expect(cache.getToken()).rejects.toThrow("network error")
        expect(await cache.getToken()).toMatchObject(token("t1"))
        cache.dispose()
    })

    it("dispose() cancels the pending background refresh", async () => {
        const fetchToken = vi.fn().mockResolvedValue(token("t1"))
        const cache = new CsrfTokenCache(fetchToken, { validitySeconds: 100, bufferSeconds: 10 })

        await cache.getToken()
        cache.dispose()
        await vi.advanceTimersByTimeAsync(200_000)

        expect(fetchToken).toHaveBeenCalledOnce()
    })

    it("rejects a buffer that is not smaller than the validity", () => {
        const fetchToken = vi.fn()
        expect(() => new CsrfTokenCache(fetchToken, { validitySeconds: 60, bufferSeconds: 60 })).toThrow(/buffer/)
        expect(() => new CsrfTokenCache(fetchToken, { validitySeconds: 60, bufferSeconds: -1 })).toThrow(/buffer/)
    })

    it("falls back to the configured defaults when no options are given", async () => {
        const fetchToken = vi.fn().mockResolvedValue(token("t1"))
        const cache = new CsrfTokenCache(fetchToken)

        await cache.getToken()

        // Default validity (1800s) - default buffer (60s): the token must still be cached well before that.
        vi.advanceTimersByTime(1_000)
        expect(await cache.getToken()).toMatchObject(token("t1"))
        expect(fetchToken).toHaveBeenCalledOnce()
        cache.dispose()
    })

    it("logs whether a token was fetched fresh or taken from the cache", async () => {
        const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
        vi.spyOn(cds, "log").mockReturnValue(log as unknown as ReturnType<typeof cds.log>)
        const cache = new CsrfTokenCache(vi.fn().mockResolvedValue(token("t1")), { validitySeconds: 1800, bufferSeconds: 60 })

        await cache.getToken()
        await cache.getToken()

        expect(log.debug).toHaveBeenCalledWith("requesting a new csrf token")
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining("fetched a new csrf token, valid until"))
        expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("csrf token taken from cache, valid until"))
        cache.dispose()
    })
})
