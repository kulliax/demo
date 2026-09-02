import crypto from "node:crypto"
import type { NextFunction, Request, Response } from "express"

/**
 * Validates CSRF tokens on incoming writes to CatalogService - the "protected S/4" side of this
 * demo. ../../shop-service talks to this service through cds-csrf-cache, which fetches a token via
 * GET here (see server.ts) and caches it instead of re-fetching one per write.
 *
 * Manual implementation, following the pattern documented at
 * https://cap.cloud.sap/docs/node.js/best-practices#cross-site-request-forgery-csrf-token,
 * without pulling in the archived `csurf` package that guide's code sample depends on. A
 * production app fronted by an App Router gets this handling for free instead.
 */
const SESSION_COOKIE = "catalog-session"
const CSRF_HEADER = "x-csrf-token"

// sessionId -> current token. Fine for a single-process demo; a real deployment without an App
// Router would keep this in whatever session store the rest of the app already uses.
const tokensBySession = new Map<string, string>()

function readSessionId(req: Request): string | undefined {
    const cookieHeader = req.headers.cookie ?? ""
    return cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))?.[1]
}

export function issueCsrfToken(req: Request, res: Response): void {
    const sessionId = readSessionId(req) ?? crypto.randomUUID()
    const token = crypto.randomBytes(24).toString("hex")
    tokensBySession.set(sessionId, token)
    console.log("[data-service] issued a csrf token")

    res.setHeader("set-cookie", `${SESSION_COOKIE}=${sessionId}; path=/; httponly`)
    res.setHeader(CSRF_HEADER, token)
    // Must never be cacheable, or a shared/reused token would defeat the point of CSRF protection.
    res.setHeader("cache-control", "no-store, no-cache, must-revalidate, proxy-revalidate")
    // Must be exactly 200 - cds-csrf-cache's CAP-destination token fetcher (unlike its plain-fetch
    // half) requires that status literally, matching what a real S/4 gateway always answers with.
    res.status(200).end()
}

export function requireCsrfToken(req: Request, res: Response, next: NextFunction): void {
    const sessionId = readSessionId(req)
    const expected = sessionId && tokensBySession.get(sessionId)
    if (!expected || req.headers[CSRF_HEADER] !== expected) {
        console.log("[data-service] rejected write: missing/invalid csrf token")
        res.setHeader(CSRF_HEADER, "Required")
        res.status(403).end()
        return
    }
    next()
}
