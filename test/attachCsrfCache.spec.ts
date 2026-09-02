import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import cds from "@sap/cds"

vi.mock("../src/capDestinationTokenFetcher", () => ({
    buildCapDestinationCsrfTokenFetcher: vi.fn()
}))

import { attachCsrfCache } from "../src/attachCsrfCache"
import { buildCapDestinationCsrfTokenFetcher } from "../src/capDestinationTokenFetcher"
import { resetSharedCsrfCaches } from "../src/sharedCsrfCaches"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeRemoteService(config: any) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlers: Record<string, (req: any) => unknown> = {}
    const service = {
        name: "testService",
        ...config,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        before: vi.fn((event: string, handler: (req: any) => unknown) => { handlers[event] = handler }),
        send: vi.fn().mockResolvedValue("ok"),
        __handlers: handlers
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return service as any
}

const csrfError = (status: number, csrfHeaderValue?: string) => ({
    reason: { response: { status, headers: csrfHeaderValue !== undefined ? { "x-csrf-token": csrfHeaderValue } : {} } }
})

beforeEach(() => {
    // Reset, not just re-stub: the call *count* is what the sharing tests assert on.
    vi.mocked(buildCapDestinationCsrfTokenFetcher).mockReset()
    vi.mocked(buildCapDestinationCsrfTokenFetcher).mockReturnValue(vi.fn().mockResolvedValue({ token: "t1", cookies: [] }))
})

afterEach(() => {
    resetSharedCsrfCaches()
    vi.restoreAllMocks()
})

describe("attachCsrfCache", () => {
    it("skips services without a destination, without registering any handler", () => {
        const srv = fakeRemoteService({ path: "/service/" })

        const cache = attachCsrfCache(srv)

        expect(cache).toBeUndefined()
        expect(srv.before).not.toHaveBeenCalled()
    })

    it("skips services without any csrf configuration", () => {
        const srv = fakeRemoteService({ destination: "s4-o2c-100", path: "/service/" })

        const cache = attachCsrfCache(srv)

        expect(cache).toBeUndefined()
        expect(srv.before).not.toHaveBeenCalled()
    })

    it("skips a service that explicitly opts out via csrf.cache: false", () => {
        const srv = fakeRemoteService({ destination: "s4-o2c-100", csrf: { url: "/service/", cache: false } })

        const cache = attachCsrfCache(srv)

        expect(cache).toBeUndefined()
        expect(srv.before).not.toHaveBeenCalled()
        expect(buildCapDestinationCsrfTokenFetcher).not.toHaveBeenCalled()
    })

    it("uses the explicit csrf.url and defaults the preflight method to get when csrf is configured as an object", () => {
        const srv = fakeRemoteService({ destination: "s4-o2c-100", path: "/service/", csrf: { url: "/service/csrf/" } })

        attachCsrfCache(srv)

        expect(buildCapDestinationCsrfTokenFetcher).toHaveBeenCalledWith("s4-o2c-100", {}, "/service/csrf/", "get")
    })

    it("falls back to credentials.path when csrf is configured as a plain boolean (zapi_sales_order_srv)", () => {
        const srv = fakeRemoteService({ destination: "s4-o2c-100", path: "/service/", csrf: true })

        attachCsrfCache(srv)

        expect(buildCapDestinationCsrfTokenFetcher).toHaveBeenCalledWith("s4-o2c-100", {}, "/service/", "get")
    })

    it("passes csrf.method through, normalized to lowercase", () => {
        const srv = fakeRemoteService({ destination: "s4-o2c-100", csrf: { url: "/service/", method: "HEAD" } })

        attachCsrfCache(srv)

        expect(buildCapDestinationCsrfTokenFetcher).toHaveBeenCalledWith("s4-o2c-100", {}, "/service/", "head")
    })

    it("falls back to get for an unsupported csrf.method value", () => {
        const srv = fakeRemoteService({ destination: "s4-o2c-100", csrf: { url: "/service/", method: "post" } })

        attachCsrfCache(srv)

        expect(buildCapDestinationCsrfTokenFetcher).toHaveBeenCalledWith("s4-o2c-100", {}, "/service/", "get")
    })

    it("passes an inline destination (credentials.url) through to the token fetcher as the object it is", () => {
        // CAP puts an object on the service for a `credentials.url` remote service, not a name - see DestinationRef.
        const destination = { name: "testService", url: "https://s4.example", username: "sap" }
        const srv = fakeRemoteService({ destination, csrf: { url: "/service/" } })

        expect(attachCsrfCache(srv)).toBeDefined()

        expect(buildCapDestinationCsrfTokenFetcher).toHaveBeenCalledWith(destination, {}, "/service/", "get")
    })

    it("passes destinationOptions through to the token fetcher", () => {
        const destinationOptions = { selectionStrategy: "alwaysProvider", useCache: true }
        const srv = fakeRemoteService({ destination: "s4-o2c-100", destinationOptions, csrf: { url: "/service/" } })

        attachCsrfCache(srv)

        expect(buildCapDestinationCsrfTokenFetcher).toHaveBeenCalledWith("s4-o2c-100", destinationOptions, "/service/", "get")
    })

    it("passes csrf.validitySeconds into the cache, overridable by an explicit options argument", async () => {
        vi.useFakeTimers()
        const fetchToken = vi.fn().mockResolvedValue({ token: "t1", cookies: [] })
        vi.mocked(buildCapDestinationCsrfTokenFetcher).mockReturnValue(fetchToken)
        const srv = fakeRemoteService({ destination: "s4-o2c-100", csrf: { url: "/service/", validitySeconds: 120 } })

        const cache = attachCsrfCache(srv, { bufferSeconds: 10 })!
        await cache.getToken()
        // Below the configured 120s validity: still cached.
        await vi.advanceTimersByTimeAsync(100_000)
        expect(fetchToken).toHaveBeenCalledOnce()
        // Past it: refetches.
        await vi.advanceTimersByTimeAsync(30_000)
        expect(fetchToken).toHaveBeenCalledTimes(2)

        cache.dispose()
        vi.useRealTimers()
    })

    it("passes csrf.autoRefresh: false into the cache, so a stale token is only re-fetched lazily on demand", async () => {
        vi.useFakeTimers()
        const fetchToken = vi.fn().mockResolvedValue({ token: "t1", cookies: [] })
        vi.mocked(buildCapDestinationCsrfTokenFetcher).mockReturnValue(fetchToken)
        const srv = fakeRemoteService({ destination: "s4-o2c-100", csrf: { url: "/service/", validitySeconds: 100, autoRefresh: false } })

        const cache = attachCsrfCache(srv)!
        await cache.getToken()
        // Well past validity: no background timer fired because autoRefresh is off.
        await vi.advanceTimersByTimeAsync(200_000)
        expect(fetchToken).toHaveBeenCalledOnce()

        cache.dispose()
        vi.useRealTimers()
    })

    it("injects the cached token and cookie header into a mutating request", async () => {
        vi.mocked(buildCapDestinationCsrfTokenFetcher).mockReturnValue(
            vi.fn().mockResolvedValue({ token: "cached-token", cookies: ["sap-usercontext=1; path=/"] }))
        const srv = fakeRemoteService({ destination: "s4-o2c-100", csrf: { url: "/service/" } })
        attachCsrfCache(srv)

        const req = { method: "POST", headers: {} as Record<string, string> }
        await srv.__handlers["*"](req)

        expect(req.headers["x-csrf-token"]).toBe("cached-token")
        // Only the name=value pair is forwarded - a cookie's path/domain attributes are not valid in a Cookie header.
        expect(req.headers["cookie"]).toBe("sap-usercontext=1")
    })

    it("does not fetch a token for a GET/HEAD request", async () => {
        const fetchToken = vi.fn().mockResolvedValue({ token: "t1", cookies: [] })
        vi.mocked(buildCapDestinationCsrfTokenFetcher).mockReturnValue(fetchToken)
        const srv = fakeRemoteService({ destination: "s4-o2c-100", csrf: { url: "/service/" } })
        attachCsrfCache(srv)

        const req = { method: "GET", headers: {} as Record<string, string> }
        await srv.__handlers["*"](req)

        expect(fetchToken).not.toHaveBeenCalled()
        expect(req.headers["x-csrf-token"]).toBeUndefined()
    })

    it("takes over CAP's csrfInBatch as well, injecting the token into safe requests too", async () => {
        // An auto-batched read goes out as an OData `$batch` POST, so a gateway can demand a token
        // for it - which is why CAP has a separate `csrfInBatch` switch for exactly those requests.
        const fetchToken = vi.fn().mockResolvedValue({ token: "batch-token", cookies: [] })
        vi.mocked(buildCapDestinationCsrfTokenFetcher).mockReturnValue(fetchToken)
        const srv = fakeRemoteService({ destination: "s4-o2c-100", csrf: { url: "/service/" }, csrfInBatch: true })
        attachCsrfCache(srv)

        // CAP's own batch preflight is switched off with the rest, so nothing fetches twice.
        expect(srv.csrfInBatch).toBeUndefined()

        const req = { method: "GET", headers: {} as Record<string, string> }
        await srv.__handlers["*"](req)

        expect(req.headers["x-csrf-token"]).toBe("batch-token")
        expect(fetchToken).toHaveBeenCalledOnce()
    })

    it("lets the request through without headers when the token fetch fails", async () => {
        vi.mocked(buildCapDestinationCsrfTokenFetcher).mockReturnValue(vi.fn().mockRejectedValue(new Error("s4 unreachable")))
        const srv = fakeRemoteService({ destination: "s4-o2c-100", csrf: { url: "/service/" } })
        attachCsrfCache(srv)

        const req = { method: "POST", headers: {} as Record<string, string> }
        await expect(srv.__handlers["*"](req)).resolves.toBeUndefined()
        expect(req.headers["x-csrf-token"]).toBeUndefined()
    })

    it("passes through a non-csrf error from send() unchanged, without retrying", async () => {
        const srv = fakeRemoteService({ destination: "s4-o2c-100", csrf: { url: "/service/" } })
        const originalSend = srv.send
        const boom = new Error("boom")
        originalSend.mockRejectedValueOnce(boom)
        attachCsrfCache(srv)

        await expect(srv.send("POST", "/entities", {})).rejects.toBe(boom)
        expect(originalSend).toHaveBeenCalledTimes(1)
    })

    it("invalidates the cache and retries exactly once when the backend rejects the token as expired", async () => {
        const fetchToken = vi.fn().mockResolvedValueOnce({ token: "stale", cookies: [] }).mockResolvedValueOnce({ token: "fresh", cookies: [] })
        vi.mocked(buildCapDestinationCsrfTokenFetcher).mockReturnValue(fetchToken)
        const srv = fakeRemoteService({ destination: "s4-o2c-100", csrf: { url: "/service/" } })
        const originalSend = srv.send
        originalSend.mockRejectedValueOnce(csrfError(403, "Required")).mockResolvedValueOnce("ok")
        const cache = attachCsrfCache(srv)!

        await srv.__handlers["*"]({ method: "POST", headers: {} })
        expect(await cache.getToken()).toMatchObject({ token: "stale", cookies: [] })

        const result = await srv.send("POST", "/entities", {})

        expect(result).toBe("ok")
        expect(originalSend).toHaveBeenCalledTimes(2)
        // the cache must have been invalidated and re-populated with the fresh token
        expect(await cache.getToken()).toMatchObject({ token: "fresh", cookies: [] })
        cache.dispose()
    })

    it("does not retry a 403 that is not a csrf-required rejection", async () => {
        const srv = fakeRemoteService({ destination: "s4-o2c-100", csrf: { url: "/service/" } })
        const originalSend = srv.send
        const forbidden = csrfError(403)
        originalSend.mockRejectedValueOnce(forbidden)
        attachCsrfCache(srv)

        await expect(srv.send("POST", "/entities", {})).rejects.toBe(forbidden)
        expect(originalSend).toHaveBeenCalledTimes(1)
    })
})

describe("attachCsrfCache with csrf.share", () => {
    const s4 = (name: string, csrf: Record<string, unknown>) =>
        fakeRemoteService({ name, destination: "s4-o2c-100", destinationOptions: { selectionStrategy: "alwaysProvider" }, csrf })

    it("gives every service its own cache by default", () => {
        const first = attachCsrfCache(s4("zsd_o2c_order_processing", { url: "/zsd/" }))
        const second = attachCsrfCache(s4("api_purchaseorder_2", { url: "/po/" }))

        expect(second).not.toBe(first)
        expect(buildCapDestinationCsrfTokenFetcher).toHaveBeenCalledTimes(2)
    })

    it("hands services on the same destination one shared cache, fetching a single token for all of them", async () => {
        const fetchToken = vi.fn().mockResolvedValue({ token: "shared-token", cookies: [] })
        vi.mocked(buildCapDestinationCsrfTokenFetcher).mockReturnValue(fetchToken)
        const owner = s4("zsd_o2c_order_processing", { url: "/zsd/", share: true })
        const joiner = s4("api_purchaseorder_2", { url: "/po/", share: true })

        const cache = attachCsrfCache(owner)!
        expect(attachCsrfCache(joiner)).toBe(cache)
        // Only the first service builds a token fetcher - the second one has no use for its own.
        expect(buildCapDestinationCsrfTokenFetcher).toHaveBeenCalledOnce()
        expect(buildCapDestinationCsrfTokenFetcher).toHaveBeenCalledWith("s4-o2c-100", { selectionStrategy: "alwaysProvider" }, "/zsd/", "get")

        const ownerReq = { method: "POST", headers: {} as Record<string, string> }
        const joinerReq = { method: "POST", headers: {} as Record<string, string> }
        await owner.__handlers["*"](ownerReq)
        await joiner.__handlers["*"](joinerReq)

        expect(ownerReq.headers["x-csrf-token"]).toBe("shared-token")
        expect(joinerReq.headers["x-csrf-token"]).toBe("shared-token")
        expect(fetchToken).toHaveBeenCalledOnce()
        cache.dispose()
    })

    it("does not share across destinations, even with share turned on for both", () => {
        const first = attachCsrfCache(fakeRemoteService({ name: "a", destination: "s4-o2c-100", csrf: { url: "/a/", share: true } }))
        const second = attachCsrfCache(fakeRemoteService({ name: "b", destination: "s4-100-pls", csrf: { url: "/b/", share: true } }))

        expect(second).not.toBe(first)
    })

    it("only shares within the named group when share is a string", () => {
        const writes = attachCsrfCache(s4("a", { url: "/a/", share: "writes" }))
        const alsoWrites = attachCsrfCache(s4("b", { url: "/b/", share: "writes" }))
        const reads = attachCsrfCache(s4("c", { url: "/c/", share: "reads" }))

        expect(alsoWrites).toBe(writes)
        expect(reads).not.toBe(writes)
    })

    it("lets an options.share argument override the csrf config", () => {
        const shared = attachCsrfCache(s4("a", { url: "/a/" }), { share: true })
        const optedOut = attachCsrfCache(s4("b", { url: "/b/", share: true }), { share: false })
        const joining = attachCsrfCache(s4("c", { url: "/c/" }), { share: true })

        expect(joining).toBe(shared)
        expect(optedOut).not.toBe(shared)
    })

    it("refreshes the shared token for every participating service when one of them is rejected", async () => {
        const fetchToken = vi.fn().mockResolvedValueOnce({ token: "stale", cookies: [] }).mockResolvedValueOnce({ token: "fresh", cookies: [] })
        vi.mocked(buildCapDestinationCsrfTokenFetcher).mockReturnValue(fetchToken)
        const owner = s4("zsd_o2c_order_processing", { url: "/zsd/", share: true })
        const joiner = s4("api_purchaseorder_2", { url: "/po/", share: true })
        owner.send.mockRejectedValueOnce(csrfError(403, "Required")).mockResolvedValueOnce("ok")
        const cache = attachCsrfCache(owner)!
        attachCsrfCache(joiner)

        await owner.__handlers["*"]({ method: "POST", headers: {} })
        await owner.send("POST", "/entities", {})

        // The joiner sees the refreshed token without a fetch of its own.
        const joinerReq = { method: "POST", headers: {} as Record<string, string> }
        await joiner.__handlers["*"](joinerReq)
        expect(joinerReq.headers["x-csrf-token"]).toBe("fresh")
        expect(fetchToken).toHaveBeenCalledTimes(2)
        cache.dispose()
    })

    it("runs the shared cache with the first service's settings, ignoring a differently configured joiner", async () => {
        vi.useFakeTimers()
        const fetchToken = vi.fn().mockResolvedValue({ token: "t1", cookies: [] })
        vi.mocked(buildCapDestinationCsrfTokenFetcher).mockReturnValue(fetchToken)

        const cache = attachCsrfCache(s4("a", { url: "/a/", share: true, validitySeconds: 200 }), { bufferSeconds: 10 })!
        attachCsrfCache(s4("b", { url: "/b/", share: true, validitySeconds: 10 }))

        await cache.getToken()
        // The joiner's much shorter validity has no effect - the owner's 200s are in force.
        await vi.advanceTimersByTimeAsync(150_000)
        expect(fetchToken).toHaveBeenCalledOnce()

        cache.dispose()
        vi.useRealTimers()
    })
})

/** Sanity check that the module under test really imports the real `@sap/cds` log, not a stub. */
describe("csrf-cache logger", () => {
    it("is created without throwing", () => {
        expect(() => cds.log("csrf-cache")).not.toThrow()
    })
})
