import { describe, expect, it, vi } from "vitest"
import { buildCapDestinationCsrfTokenFetcher, CapInternals } from "../src/capDestinationTokenFetcher"

/**
 * `buildCapDestinationCsrfTokenFetcher` normally resolves both the CAP client-selection module and
 * the (optional!) SAP Cloud SDK itself via a runtime `require()` (see the module's own comments for
 * why - `@sap/cds/libx/_runtime/remote/utils/*` is an internal-but-exported deep path, and the
 * Cloud SDK must stay lazy so a project without it installed never fails to even load this module).
 * Vitest's `vi.mock` does not reliably intercept that kind of dynamic `require()`, so these tests
 * pass fake `overrides` directly instead.
 */
const fakeCapInternals = (shouldUseCloudSdk: boolean): CapInternals & { nativeFetch: ReturnType<typeof vi.fn> } => ({
    shouldUseCloudSdk: () => shouldUseCloudSdk,
    nativeFetch: vi.fn()
})

describe("buildCapDestinationCsrfTokenFetcher", () => {
    it("uses the Cloud SDK when shouldUseCloudSdk(destination) says so, letting CAP's own decision drive the client choice", async () => {
        const capInternals = fakeCapInternals(true)
        const cloudSdkFetch = vi.fn().mockResolvedValue({ status: 200, headers: { "x-csrf-token": "sdk-token", "set-cookie": "sap-usercontext=1; path=/" } })

        const result = await buildCapDestinationCsrfTokenFetcher("s4-o2c-100", { useCache: true }, "/service/", "get", { capInternals, cloudSdkFetch })()

        expect(cloudSdkFetch).toHaveBeenCalledExactlyOnceWith(
            { destinationName: "s4-o2c-100", useCache: true },
            { method: "get", url: "/service/", headers: { "x-csrf-token": "Fetch" } })
        expect(capInternals.nativeFetch).not.toHaveBeenCalled()
        expect(result).toEqual({ token: "sdk-token", cookies: ["sap-usercontext=1; path=/"] })
    })

    it("uses CAP's own native fetch when shouldUseCloudSdk(destination) says so", async () => {
        const capInternals = fakeCapInternals(false)
        capInternals.nativeFetch.mockResolvedValue({ status: 200, headers: { "x-csrf-token": "native-token", "set-cookie": "sap-usercontext=2; path=/" } })
        const cloudSdkFetch = vi.fn()

        const result = await buildCapDestinationCsrfTokenFetcher("local-dest", {}, "/service/", "head", { capInternals, cloudSdkFetch })()

        expect(capInternals.nativeFetch).toHaveBeenCalledExactlyOnceWith(
            { destinationName: "local-dest" },
            { method: "HEAD", url: "/service/", headers: { "x-csrf-token": "Fetch" } })
        expect(cloudSdkFetch).not.toHaveBeenCalled()
        expect(result).toEqual({ token: "native-token", cookies: ["sap-usercontext=2; path=/"] })
    })

    it("falls back to native fetch when the Cloud SDK is not installed, even though CAP would otherwise have picked it", async () => {
        const capInternals = fakeCapInternals(true)
        capInternals.nativeFetch.mockResolvedValue({ status: 200, headers: { "x-csrf-token": "native-token" } })

        // cloudSdkFetch: null - the same "not installed" state resolveCloudSdkExecutor() reaches on a MODULE_NOT_FOUND.
        const result = await buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service/", "get", { capInternals, cloudSdkFetch: null })()

        expect(capInternals.nativeFetch).toHaveBeenCalledOnce()
        expect(result.token).toBe("native-token")
    })

    it("tries the Cloud SDK first when CAP's own client-selection module could not be loaded (capInternals: null)", async () => {
        const cloudSdkFetch = vi.fn().mockResolvedValue({ status: 200, headers: { "x-csrf-token": "sdk-token" } })

        const result = await buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service/", "get", { capInternals: null, cloudSdkFetch })()

        expect(cloudSdkFetch).toHaveBeenCalledOnce()
        expect(result.token).toBe("sdk-token")
    })

    it("throws a clear error when neither CAP's client-selection module nor the Cloud SDK is available", async () => {
        const fetcher = buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service/", "get", { capInternals: null, cloudSdkFetch: null })

        await expect(fetcher()).rejects.toThrow(/neither the sap cloud sdk nor/i)
    })

    it("passes destinationOptions through unchanged, the same way CAP itself merges them into the destination reference", async () => {
        const capInternals = fakeCapInternals(true)
        const cloudSdkFetch = vi.fn().mockResolvedValue({ status: 200, headers: { "x-csrf-token": "t" } })

        await buildCapDestinationCsrfTokenFetcher("s4-o2c-100", { selectionStrategy: "alwaysProvider" }, "/service/", "get", { capInternals, cloudSdkFetch })()

        expect(cloudSdkFetch).toHaveBeenCalledWith(
            { destinationName: "s4-o2c-100", selectionStrategy: "alwaysProvider" }, expect.anything())
    })

    it("throws when the backend does not return a token", async () => {
        const capInternals = fakeCapInternals(true)
        const cloudSdkFetch = vi.fn().mockResolvedValue({ status: 200, headers: {} })

        await expect(buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service/", "get", { capInternals, cloudSdkFetch })()).rejects.toThrow(/csrf token/i)
    })

    it("throws when the preflight response is not a 200", async () => {
        const capInternals = fakeCapInternals(true)
        const cloudSdkFetch = vi.fn().mockResolvedValue({ status: 502, headers: { "x-csrf-token": "irrelevant" } })

        await expect(buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service/", "get", { capInternals, cloudSdkFetch })()).rejects.toThrow(/502/)
    })

    it("returns no cookies when the response carries none", async () => {
        const capInternals = fakeCapInternals(true)
        const cloudSdkFetch = vi.fn().mockResolvedValue({ status: 200, headers: { "x-csrf-token": "sdk-token" } })

        const result = await buildCapDestinationCsrfTokenFetcher("s4-o2c-100", {}, "/service/", "get", { capInternals, cloudSdkFetch })()

        expect(result.cookies).toEqual([])
    })
})
