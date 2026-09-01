import { beforeEach, describe, expect, it, vi } from "vitest"
import { CsrfTokenCache } from "../src/CsrfTokenCache"
import { buildCsrfTokenFetcher, createCsrfFetch } from "../src/csrfFetch"

const csrfResponse = (token = "csrf-token-1", cookie = "sap-usercontext=abc; path=/") =>
    new Response(null, { headers: { "x-csrf-token": token, "set-cookie": cookie } })

describe("buildCsrfTokenFetcher", () => {
    it("requests a token with GET and the Fetch header, and reads back token + cookies", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(csrfResponse())

        const result = await buildCsrfTokenFetcher("https://s4.example/service/", {}, fetchImpl)()

        expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("https://s4.example/service/", expect.objectContaining({
            method: "GET",
            headers: expect.objectContaining({ "x-csrf-token": "Fetch" })
        }))
        expect(result.token).toBe("csrf-token-1")
        expect(result.cookies).toContain("sap-usercontext=abc; path=/")
    })

    it("throws when the backend does not return a token", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))

        await expect(buildCsrfTokenFetcher("https://s4.example/service/", {}, fetchImpl)()).rejects.toThrow(/csrf token/i)
    })

    it("throws when the fetch request itself fails", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 502 }))

        await expect(buildCsrfTokenFetcher("https://s4.example/service/", {}, fetchImpl)()).rejects.toThrow(/502/)
    })
})

describe("createCsrfFetch", () => {
    let cache: CsrfTokenCache

    beforeEach(() => {
        cache = new CsrfTokenCache(vi.fn().mockResolvedValue({ token: "t1", cookies: ["sap-usercontext=1; path=/"] }))
    })

    it("passes GET/HEAD/OPTIONS requests through untouched, without consulting the cache", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"))
        const protectedFetch = createCsrfFetch(cache, fetchImpl)
        const getToken = vi.spyOn(cache, "getToken")

        await protectedFetch("https://s4.example/entities", { method: "GET" })
        await protectedFetch("https://s4.example/entities", { method: "HEAD" })
        await protectedFetch("https://s4.example/entities")

        expect(getToken).not.toHaveBeenCalled()
        expect(fetchImpl).toHaveBeenCalledTimes(3)
        cache.dispose()
    })

    it("injects the cached token and cookie into a POST request", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response("created", { status: 201 }))
        const protectedFetch = createCsrfFetch(cache, fetchImpl)

        await protectedFetch("https://s4.example/entities", { method: "POST", body: "{}" })

        const [, init] = fetchImpl.mock.calls[0]
        const headers = init.headers as Headers
        expect(headers.get("x-csrf-token")).toBe("t1")
        // Only the name=value pair is forwarded - a cookie's path/domain attributes are not valid in a Cookie header.
        expect(headers.get("cookie")).toBe("sap-usercontext=1")
        cache.dispose()
    })

    it("invalidates the cache and retries exactly once when the backend rejects the token as expired", async () => {
        const rejection = new Response(null, { status: 403, headers: { "x-csrf-token": "Required" } })
        const success = new Response("created", { status: 201 })
        const fetchToken = vi.fn()
            .mockResolvedValueOnce({ token: "stale", cookies: [] })
            .mockResolvedValueOnce({ token: "fresh", cookies: [] })
        const freshCache = new CsrfTokenCache(fetchToken)
        const fetchImpl = vi.fn().mockResolvedValueOnce(rejection).mockResolvedValueOnce(success)
        const protectedFetch = createCsrfFetch(freshCache, fetchImpl)

        const response = await protectedFetch("https://s4.example/entities", { method: "POST" })

        expect(response.status).toBe(201)
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        const secondCallHeaders = fetchImpl.mock.calls[1][1].headers as Headers
        expect(secondCallHeaders.get("x-csrf-token")).toBe("fresh")
        freshCache.dispose()
    })

    it("gives up after a single retry and returns the second failed response", async () => {
        const rejection = () => new Response(null, { status: 403, headers: { "x-csrf-token": "Required" } })
        const fetchToken = vi.fn().mockResolvedValueOnce({ token: "t1", cookies: [] }).mockResolvedValueOnce({ token: "t2", cookies: [] })
        const stubbornCache = new CsrfTokenCache(fetchToken)
        const fetchImpl = vi.fn().mockResolvedValueOnce(rejection()).mockResolvedValueOnce(rejection())
        const protectedFetch = createCsrfFetch(stubbornCache, fetchImpl)

        const response = await protectedFetch("https://s4.example/entities", { method: "POST" })

        expect(response.status).toBe(403)
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        stubbornCache.dispose()
    })

    it("does not retry a plain 403 that is not a csrf rejection", async () => {
        const forbidden = new Response(null, { status: 403 })
        const fetchImpl = vi.fn().mockResolvedValue(forbidden)
        const protectedFetch = createCsrfFetch(cache, fetchImpl)

        const response = await protectedFetch("https://s4.example/entities", { method: "POST" })

        expect(response.status).toBe(403)
        expect(fetchImpl).toHaveBeenCalledOnce()
        cache.dispose()
    })
})
