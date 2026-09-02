import { afterEach, beforeEach, describe, expect, it } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import cds from "@sap/cds"
import { buildCapDestinationCsrfTokenFetcher } from "../src/capDestinationTokenFetcher"

/**
 * `buildCapDestinationCsrfTokenFetcher` reaches into two undocumented-but-exported deep paths of
 * the *installed* `@sap/cds` package (see that module's own comments for why, and for what happens
 * if a future release moves them: the require fails gracefully instead of crashing).
 *
 * Every test in `capDestinationTokenFetcher.spec.ts` passes fake `overrides` instead of letting that
 * `require()` run - deliberately, per that file's own comment, since `vi.mock` does not reliably
 * intercept it. That means none of those tests would notice if `@sap/cds` actually moved or renamed
 * either export - the fallback is silent by design (a warning log, not a thrown error). These tests
 * exercise the real, installed internals instead, with no overrides at all.
 */
function startFakeS4Server() {
    const server = http.createServer((req, res) => {
        if (req.method === "GET" || req.method === "HEAD") {
            res.setHeader("x-csrf-token", "real-internals-token")
            res.setHeader("set-cookie", "sap-usercontext=real-internals-session; path=/")
            res.writeHead(200)
            res.end()
            return
        }
        res.writeHead(404)
        res.end()
    })

    return {
        server,
        url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
        listen: () => new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)),
        close: () => new Promise<void>(resolve => server.close(() => resolve()))
    }
}

describe("@sap/cds's internal client-selection modules (real, unmocked require)", () => {
    it("still export the exact shape buildCapDestinationCsrfTokenFetcher relies on", () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberately the same deep, undocumented require capDestinationTokenFetcher.ts itself does; if @sap/cds ever moves these, this throws and this test fails loudly
        const { shouldUseCloudSdk } = require("@sap/cds/libx/_runtime/remote/utils/cloudSdkProvider")
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { executeHttpRequest } = require("@sap/cds/libx/_runtime/remote/utils/fetchClient")

        expect(typeof shouldUseCloudSdk).toBe("function")
        expect(typeof executeHttpRequest).toBe("function")
    })
})

describe("buildCapDestinationCsrfTokenFetcher against real @sap/cds internals (no overrides)", () => {
    let fakeS4: ReturnType<typeof startFakeS4Server>

    beforeEach(async () => {
        fakeS4 = startFakeS4Server()
        await fakeS4.listen()
        // CAP's own convention for locally-resolvable destinations, read by the real
        // shouldUseCloudSdk()/executeHttpRequest() this test deliberately does not mock.
        process.env.destinations = JSON.stringify([
            { name: "cap-internals-test", url: fakeS4.url(), authentication: "NoAuthentication" }
        ])
        // Forces CAP's own shouldUseCloudSdk() to pick native fetch deterministically, regardless of
        // whether the SAP Cloud SDK happens to be installed in this environment - see cloudSdkProvider.js.
        cds.env.remote = { ...cds.env.remote, native_fetch: true }
    })

    afterEach(async () => {
        delete process.env.destinations
        cds.env.remote = { ...cds.env.remote, native_fetch: undefined }
        await fakeS4.close()
    })

    it("fetches a real token through CAP's own native-fetch client, end to end", async () => {
        const fetcher = buildCapDestinationCsrfTokenFetcher("cap-internals-test", {}, "/", "get")

        const result = await fetcher()

        expect(result).toEqual({
            token: "real-internals-token",
            cookies: ["sap-usercontext=real-internals-session; path=/"]
        })
    })
})
