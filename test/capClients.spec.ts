import { describe, expect, it, vi } from "vitest"
import { CapInternals, chooseExecutor, describeDestination, toDestinationRef } from "../src/capClients"

/**
 * `chooseExecutor` is the client choice as a pure function of what could be loaded, which is what
 * makes it testable at all: the real thing behind it (`resolveExecutor`) resolves both candidates
 * through runtime `require()`s that `vi.mock` cannot reliably intercept - those are covered
 * unmocked, against a real server, in `capDestinationTokenFetcher.e2e.test.ts`.
 */
function fakeCapInternals(shouldUseCloudSdk: boolean) {
    const internals = {
        shouldUseCloudSdk: vi.fn().mockReturnValue(shouldUseCloudSdk),
        nativeFetch: vi.fn()
    }
    return internals satisfies CapInternals
}

const requestConfig = { method: "GET", url: "/service/", headers: { "x-csrf-token": "Fetch" } }

describe("chooseExecutor", () => {
    it("returns the Cloud SDK when CAP's own shouldUseCloudSdk() says so, told not to fetch a nested csrf token", async () => {
        const internals = fakeCapInternals(true)
        const cloudSdkFetch = vi.fn().mockResolvedValue({ status: 200, headers: {} })

        const execute = chooseExecutor("s4-o2c-100", internals, cloudSdkFetch)
        await execute({ destinationName: "s4-o2c-100" }, requestConfig)

        // CAP is asked about the destination as it stands on the service, not about the wrapped reference.
        expect(internals.shouldUseCloudSdk).toHaveBeenCalledExactlyOnceWith("s4-o2c-100")
        expect(cloudSdkFetch).toHaveBeenCalledExactlyOnceWith({ destinationName: "s4-o2c-100" }, requestConfig, { fetchCsrfToken: false })
        expect(internals.nativeFetch).not.toHaveBeenCalled()
    })

    it("returns CAP's own native client, unwrapped, when shouldUseCloudSdk() says so", () => {
        const internals = fakeCapInternals(false)

        expect(chooseExecutor("local-dest", internals, vi.fn())).toBe(internals.nativeFetch)
    })

    it("asks CAP about an inline destination (credentials.url) as the object it is", () => {
        const destination = { name: "S4bupa", url: "https://s4.example" }
        const internals = fakeCapInternals(false)

        chooseExecutor(destination, internals, null)

        expect(internals.shouldUseCloudSdk).toHaveBeenCalledWith(destination)
    })

    it("falls back to CAP's native client when the Cloud SDK is not installed, even though CAP would have picked it", () => {
        const internals = fakeCapInternals(true)

        expect(chooseExecutor("s4-o2c-100", internals, null)).toBe(internals.nativeFetch)
    })

    it("uses the Cloud SDK without asking when CAP's client-selection module could not be loaded", async () => {
        const cloudSdkFetch = vi.fn().mockResolvedValue({ status: 200, headers: {} })

        await chooseExecutor("s4-o2c-100", null, cloudSdkFetch)({ destinationName: "s4-o2c-100" }, requestConfig)

        expect(cloudSdkFetch).toHaveBeenCalledOnce()
    })

    it("throws an error naming both clients when neither could be loaded", () => {
        expect(() => chooseExecutor("s4-o2c-100", null, null))
            .toThrow(/neither the sap cloud sdk nor .* native fetch client/i)
    })
})

describe("toDestinationRef", () => {
    it("wraps a destination name together with the options that decide which destination it resolves to", () => {
        expect(toDestinationRef("s4-o2c-100", { selectionStrategy: "alwaysProvider" }))
            .toEqual({ destinationName: "s4-o2c-100", selectionStrategy: "alwaysProvider" })
    })

    it("passes an inline destination through untouched - wrapping it would make a client look up a destination called '[object Object]'", () => {
        const destination = { name: "S4bupa", url: "https://s4.example", username: "sap" }

        expect(toDestinationRef(destination, { useCache: true })).toBe(destination)
    })
})

describe("describeDestination", () => {
    it("names a destination by name, an inline one by its url, and neither by a readable placeholder", () => {
        expect(describeDestination("s4-o2c-100")).toBe("s4-o2c-100")
        expect(describeDestination({ name: "S4bupa", url: "https://s4.example" })).toBe("S4bupa")
        expect(describeDestination({ url: "https://s4.example" })).toBe("https://s4.example")
        expect(describeDestination({})).toBe("inline destination")
    })
})
