import { afterEach, describe, expect, it, vi } from "vitest"
import cds from "@sap/cds"

// Only the client choice is faked - which client CAP picks is `capClients.spec.ts`'s subject, and
// the real, unmocked resolution is `capDestinationTokenFetcher.e2e.test.ts`'s.
vi.mock("../src/capClients", async importOriginal => ({
    ...await importOriginal<typeof import("../src/capClients")>(),
    resolveExecutor: vi.fn()
}))

import { resolveExecutor } from "../src/capClients"
import { buildCapDestinationCsrfTokenFetcher } from "../src/capDestinationTokenFetcher"

const preflightResponse = (headers: Record<string, unknown>, status = 200) => ({ status, headers })

/** Installs the executor every preflight in this file runs through, and hands it back for assertions. */
function client(...responses: (ReturnType<typeof preflightResponse> | Error)[]) {
    const execute = vi.fn()
    for (const response of responses)
        if (response instanceof Error) execute.mockRejectedValueOnce(response)
        else execute.mockResolvedValueOnce(response)
    if (responses.length === 1 && !(responses[0] instanceof Error)) execute.mockResolvedValue(responses[0])
    vi.mocked(resolveExecutor).mockReturnValue(execute)
    return execute
}

const rejectionWith = (status: number, headers: Record<string, unknown>) =>
    Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, headers } })

afterEach(() => {
    vi.mocked(resolveExecutor).mockReset()
    cds.context = undefined
})

describe("buildCapDestinationCsrfTokenFetcher, the preflight request", () => {
    it("fetches with the destination reference, an uppercase verb and the Fetch header", async () => {
        const execute = client(preflightResponse({ "x-csrf-token": "token-1", "set-cookie": "sap-usercontext=1; path=/" }))

        const result = await buildCapDestinationCsrfTokenFetcher("s4-o2c-100", { useCache: true }, "/service/", "get")()

        expect(execute).toHaveBeenCalledExactlyOnceWith(
            { destinationName: "s4-o2c-100", useCache: true },
            { method: "GET", url: "/service/", headers: { "x-csrf-token": "Fetch" } })
        expect(result).toEqual({ token: "token-1", cookies: ["sap-usercontext=1; path=/"] })
    })

    it("uses HEAD when csrf.method asks for it, again uppercase", async () => {
        const execute = client(preflightResponse({ "x-csrf-token": "token-1" }))

        await buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service/", "head")()

        expect(execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "HEAD" }))
    })

    it("hands an inline destination (credentials.url) over unwrapped", async () => {
        const destination = { name: "S4bupa", url: "https://s4.example" }
        const execute = client(preflightResponse({ "x-csrf-token": "token-1" }))

        await buildCapDestinationCsrfTokenFetcher(destination, {}, "/service/", "get")()

        expect(execute).toHaveBeenCalledWith(destination, expect.anything())
    })

    it("carries the correlation headers of the request that triggered the fetch, the same two CAP sets", async () => {
        cds.context = { id: "corr-42" } as unknown as typeof cds.context
        const execute = client(preflightResponse({ "x-csrf-token": "token-1" }))

        await buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service/", "get")()

        expect(execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            headers: { "x-correlation-id": "corr-42", "x-correlationid": "corr-42", "x-csrf-token": "Fetch" }
        }))
    })

    it("sends no correlation headers at all for a background refresh, which has no request context", async () => {
        const execute = client(preflightResponse({ "x-csrf-token": "token-1" }))

        await buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service/", "get")()

        expect(execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            headers: { "x-csrf-token": "Fetch" }
        }))
    })

    it("asks for the client on every fetch, the way cds.RemoteService re-decides it per request", async () => {
        client(preflightResponse({ "x-csrf-token": "token-1" }))
        const fetcher = buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service/", "get")

        await fetcher()
        await fetcher()

        expect(resolveExecutor).toHaveBeenCalledTimes(2)
        expect(resolveExecutor).toHaveBeenCalledWith("s4-o2c-100")
    })
})

describe("buildCapDestinationCsrfTokenFetcher, reading the preflight response", () => {
    it("throws when the backend does not return a token", async () => {
        client(preflightResponse({}, 200))

        await expect(buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service/", "get")()).rejects.toThrow(/csrf token/i)
    })

    it("takes the token from a rejected preflight when the backend still sent one - CAP and the Cloud SDK both do", async () => {
        // Both clients reject a non-2xx by throwing, with the response on the error; some SAP
        // systems answer a preflight with 401/403 and hand out a usable token anyway.
        client(rejectionWith(401, { "x-csrf-token": "token-from-401", "set-cookie": ["sap-usercontext=3; path=/"] }))

        const result = await buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service/", "get")()

        expect(result).toEqual({ token: "token-from-401", cookies: ["sap-usercontext=3; path=/"] })
    })

    it("surfaces the client's own error when a rejected preflight carries no token either", async () => {
        const rejection = rejectionWith(502, { "content-type": "text/html" })
        client(rejection, rejection)

        await expect(buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service/", "get")())
            .rejects.toThrow(/status code 502/)
    })

    it("reads the token header case-insensitively, as the Cloud SDK's own csrf middleware does", async () => {
        client(preflightResponse({ "X-CSRF-Token": "cased-token", "Set-Cookie": "sap-usercontext=4; path=/" }))

        const result = await buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service/", "get")()

        expect(result).toEqual({ token: "cased-token", cookies: ["sap-usercontext=4; path=/"] })
    })

    it("returns no cookies when the response carries none", async () => {
        client(preflightResponse({ "x-csrf-token": "token-1" }))

        const result = await buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service/", "get")()

        expect(result.cookies).toEqual([])
    })
})

describe("buildCapDestinationCsrfTokenFetcher, trailing-slash retry", () => {
    it("tries the csrf url with a trailing slash first, then without - the S/4 redirect workaround CAP and the Cloud SDK both implement", async () => {
        const execute = client(new Error("redirected"), preflightResponse({ "x-csrf-token": "second-attempt-token" }))

        const result = await buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/sap/opu/odata/sap/API_X", "get")()

        expect(execute.mock.calls.map(([, config]) => (config as { url: string }).url))
            .toEqual(["/sap/opu/odata/sap/API_X/", "/sap/opu/odata/sap/API_X"])
        expect(result.token).toBe("second-attempt-token")
    })

    it("does not retry once the first attempt came back with a token", async () => {
        const execute = client(preflightResponse({ "x-csrf-token": "first-attempt-token" }))

        await buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service", "get")()

        expect(execute).toHaveBeenCalledOnce()
    })

    it("surfaces the second attempt's error when both fail", async () => {
        client(new Error("first attempt failed"), new Error("second attempt failed"))

        await expect(buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service", "get")())
            .rejects.toThrow(/second attempt failed/)
    })
})
