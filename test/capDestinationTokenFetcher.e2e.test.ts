import { afterEach, beforeEach, describe, expect, it } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import cds from "@sap/cds"
import { buildCapDestinationCsrfTokenFetcher } from "../src/capDestinationTokenFetcher"

/**
 * Every test in `capDestinationTokenFetcher.spec.ts` passes fake clients via `overrides`, so none
 * of them would notice if `@sap/cds` moved the two internal-but-exported modules this plugin asks
 * for its client choice and native execution, or if `@sap-cloud-sdk/http-client` changed the API it
 * calls. The fallback for a moved `@sap/cds` export is silent by design (a warning log, not a
 * thrown error), so it needs a test that is loud instead. These tests use neither overrides nor
 * fakes: a real HTTP server, the real `destinations` convention, and the two real clients.
 */
describe("@sap/cds's internal client-selection and native-fetch modules (real, unmocked require)", () => {
    it("still export the exact shape buildCapDestinationCsrfTokenFetcher relies on", () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberately the same deep, undocumented require capDestinationTokenFetcher.ts itself does; if @sap/cds ever moves these, this throws and this test fails loudly
        const { shouldUseCloudSdk } = require("@sap/cds/libx/_runtime/remote/utils/cloudSdkProvider")
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { executeHttpRequest } = require("@sap/cds/libx/_runtime/remote/utils/fetchClient")

        expect(typeof shouldUseCloudSdk).toBe("function")
        expect(typeof executeHttpRequest).toBe("function")
    })
})

function startFakeS4Server() {
    let requests: { method: string, url: string, headers: http.IncomingHttpHeaders }[] = []

    const server = http.createServer((req, res) => {
        requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers })
        if (req.method === "GET" || req.method === "HEAD") {
            res.setHeader("x-csrf-token", "real-token")
            res.setHeader("set-cookie", "sap-usercontext=real-session; path=/")
            res.writeHead(200)
            res.end()
            return
        }
        res.writeHead(404)
        res.end()
    })

    return {
        url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
        requests: () => requests,
        listen: () => new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => { requests = []; resolve() })),
        close: () => new Promise<void>(resolve => server.close(() => resolve()))
    }
}

describe("buildCapDestinationCsrfTokenFetcher against a real backend, with no overrides at all", () => {
    let fakeS4: ReturnType<typeof startFakeS4Server>

    beforeEach(async () => {
        fakeS4 = startFakeS4Server()
        await fakeS4.listen()
        // CAP's and the Cloud SDK's shared convention for a locally resolvable destination - the
        // real thing, read by whichever of the two clients the fetcher picks.
        process.env.destinations = JSON.stringify([
            { name: "csrf-cache-e2e", url: fakeS4.url(), authentication: "NoAuthentication" }
        ])
    })

    afterEach(async () => {
        delete process.env.destinations
        cds.env.remote = { ...cds.env.remote, native_fetch: undefined }
        await fakeS4.close()
    })

    it("fetches a real token through CAP's own native-fetch client when cds.env.remote.native_fetch is set", async () => {
        cds.env.remote = { ...cds.env.remote, native_fetch: true }

        const result = await buildCapDestinationCsrfTokenFetcher("csrf-cache-e2e", {}, "/", "get")()

        expect(result).toEqual({ token: "real-token", cookies: ["sap-usercontext=real-session; path=/"] })
        expect(fakeS4.requests()).toEqual([expect.objectContaining({
            method: "GET",
            url: "/",
            headers: expect.objectContaining({ "x-csrf-token": "Fetch" })
        })])
    })

    it("fetches a real token through the real @sap-cloud-sdk/http-client, which is what a BTP destination always uses", async () => {
        // Switching native_fetch off makes CAP's own shouldUseCloudSdk() pick the Cloud SDK
        // deterministically - and this is the one test that exercises its real API shape.
        cds.env.remote = { ...cds.env.remote, native_fetch: false }

        const result = await buildCapDestinationCsrfTokenFetcher("csrf-cache-e2e", {}, "/", "get")()

        expect(result.token).toBe("real-token")
        expect(result.cookies).toEqual(["sap-usercontext=real-session; path=/"])
        expect(fakeS4.requests()).toEqual([expect.objectContaining({
            method: "GET",
            headers: expect.objectContaining({ "x-csrf-token": "Fetch" })
        })])
    })

    it("fetches a real token with a HEAD preflight, the verb CAP's own csrf.method defaults to", async () => {
        cds.env.remote = { ...cds.env.remote, native_fetch: true }

        const result = await buildCapDestinationCsrfTokenFetcher("csrf-cache-e2e", {}, "/", "head")()

        expect(result.token).toBe("real-token")
        expect(fakeS4.requests()[0].method).toBe("HEAD")
    })

    it("resolves an inline destination (credentials.url) without the destinations env var at all", async () => {
        cds.env.remote = { ...cds.env.remote, native_fetch: true }
        const url = fakeS4.url()
        delete process.env.destinations

        const result = await buildCapDestinationCsrfTokenFetcher({ name: "inline", url }, {}, "/service/", "get")()

        expect(result.token).toBe("real-token")
        expect(fakeS4.requests()[0].url).toBe("/service/")
    })
})
