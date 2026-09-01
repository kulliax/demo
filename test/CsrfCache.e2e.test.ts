import { afterEach, beforeEach, describe, expect, it } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { CsrfTokenCache } from "../src/CsrfTokenCache"
import { buildCsrfTokenFetcher, createCsrfFetch } from "../src/csrfFetch"

/**
 * Exercises the plugin's native-`fetch` half (`CsrfTokenCache` + `buildCsrfTokenFetcher` +
 * `createCsrfFetch`) against a real HTTP server over real sockets, standing in for an S/4 gateway:
 *
 * - GET with `x-csrf-token: Fetch` answers with the currently accepted token and a session cookie.
 * - A mutating request without that exact token (or without the matching session cookie) is
 *   rejected with `403` + `x-csrf-token: Required`, the way S/4 rejects an expired/invalid token.
 *
 * No mocks are involved on the HTTP layer - only the server's accepted-token state is a test double.
 */
function startFakeS4Server() {
    let acceptedToken = "token-0"
    let acceptedSession = "session-0"
    let generation = 0
    let tokenFetchCount = 0
    let acceptedRequestCount = 0
    let rejectedRequestCount = 0

    const server = http.createServer((req, res) => {
        if (req.method === "GET") {
            tokenFetchCount++
            res.setHeader("x-csrf-token", acceptedToken)
            res.setHeader("set-cookie", `sap-usercontext=${acceptedSession}; path=/`)
            res.writeHead(200)
            res.end()
            return
        }

        const cookieHeader = req.headers.cookie ?? ""
        const tokenHeader = req.headers["x-csrf-token"]
        if (tokenHeader === acceptedToken && cookieHeader.includes(acceptedSession)) {
            acceptedRequestCount++
            res.writeHead(201)
            res.end("created")
            return
        }

        rejectedRequestCount++
        res.setHeader("x-csrf-token", "Required")
        res.writeHead(403)
        res.end()
    })

    return {
        server,
        url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
        listen: () => new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)),
        close: () => new Promise<void>(resolve => server.close(() => resolve())),
        /** Simulates the backend unilaterally invalidating the session, as a real expiry would. */
        rotateAcceptedToken: () => {
            acceptedToken = `token-${++generation}-rotated`
            acceptedSession = `session-${generation}-rotated`
        },
        counts: () => ({ tokenFetchCount, acceptedRequestCount, rejectedRequestCount })
    }
}

let fakeS4: ReturnType<typeof startFakeS4Server>
let cache: CsrfTokenCache

beforeEach(async () => {
    fakeS4 = startFakeS4Server()
    await fakeS4.listen()
})

afterEach(async () => {
    cache?.dispose()
    await fakeS4.close()
})

describe("CsrfTokenCache against a real HTTP server", () => {
    it("fetches the token once and reuses it across many POST requests", async () => {
        cache = new CsrfTokenCache(buildCsrfTokenFetcher(fakeS4.url()), { validitySeconds: 1800, bufferSeconds: 60 })
        const protectedFetch = createCsrfFetch(cache)

        const responses = await Promise.all(
            Array.from({ length: 5 }, () => protectedFetch(fakeS4.url(), { method: "POST", body: "{}" })))

        expect(responses.every(response => response.status === 201)).toBe(true)
        expect(fakeS4.counts()).toEqual({ tokenFetchCount: 1, acceptedRequestCount: 5, rejectedRequestCount: 0 })
    })

    it("proactively refreshes in the background before the token is used again, with no request ever rejected", async () => {
        cache = new CsrfTokenCache(buildCsrfTokenFetcher(fakeS4.url()), { validitySeconds: 1, bufferSeconds: 0.6 })
        const protectedFetch = createCsrfFetch(cache)

        const first = await protectedFetch(fakeS4.url(), { method: "POST", body: "{}" })
        expect(first.status).toBe(201)
        expect(fakeS4.counts().tokenFetchCount).toBe(1)

        // The backend rotates its session exactly once, independently of our cache - a proactive
        // refresh that runs on time picks up the *new* token before the next request needs it.
        fakeS4.rotateAcceptedToken()
        await new Promise(resolve => setTimeout(resolve, 700))

        const second = await protectedFetch(fakeS4.url(), { method: "POST", body: "{}" })

        expect(second.status).toBe(201)
        expect(fakeS4.counts().rejectedRequestCount).toBe(0)
        expect(fakeS4.counts().tokenFetchCount).toBeGreaterThanOrEqual(2)
    })

    it("recovers from a 403 csrf rejection by invalidating and retrying exactly once", async () => {
        cache = new CsrfTokenCache(buildCsrfTokenFetcher(fakeS4.url()), { validitySeconds: 1800, bufferSeconds: 60, autoRefresh: false })
        const protectedFetch = createCsrfFetch(cache)

        await protectedFetch(fakeS4.url(), { method: "POST", body: "{}" })
        expect(fakeS4.counts().acceptedRequestCount).toBe(1)

        // The backend invalidates the session out of band (e.g. real 30-minute expiry) - our cache
        // has no way to know ahead of time, so the next request must fail over once and recover.
        fakeS4.rotateAcceptedToken()

        const response = await protectedFetch(fakeS4.url(), { method: "POST", body: "{}" })

        expect(response.status).toBe(201)
        const counts = fakeS4.counts()
        expect(counts.rejectedRequestCount).toBe(1)
        expect(counts.acceptedRequestCount).toBe(2)
        expect(counts.tokenFetchCount).toBe(2)
    })
})
