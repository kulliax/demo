import cds from "@sap/cds"
import type { Application } from "express"
import { issueCsrfToken, requireCsrfToken } from "./csrfProtection"

/**
 * Requires a CSRF token for every write against CatalogService, the same protocol a real S/4
 * OData gateway enforces - see ../../shop-service, which uses cds-csrf-cache to fetch and cache
 * that token instead of paying for a fresh fetch on every write.
 *
 * The fetch route is registered on the bare service path only (never a sub-path like /Products or
 * /Orders), so ordinary reads/writes against those entities are untouched and still handled by
 * CAP's generic providers - only the token handshake itself is intercepted here.
 */
cds.on("bootstrap", (app: Application) => {
    app.head("/odata/v4/catalog", issueCsrfToken)
    app.get("/odata/v4/catalog", issueCsrfToken)
    app.post("/odata/v4/catalog/Orders", requireCsrfToken, (req, res, next) => next())
})

export default cds.server
