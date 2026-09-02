import cds from "@sap/cds"

export class ShopService extends cds.ApplicationService {
    async init() {
        const Catalog = await cds.connect.to("CatalogService")

        // Forwards every query untouched to CatalogService (../../data-service). CAP does not
        // auto-forward generic CRUD for a pure projection onto a remote service - this is the
        // minimal handler it requires (see https://cap.cloud.sap/docs/guides/services/consuming-services#expose-remote-services).
        // cds-csrf-cache (attached automatically via its cds-plugin.js) injects the cached CSRF
        // token into the outgoing CREATE below - this handler never sees or handles CSRF itself.
        this.on(["READ", "CREATE"], ["Products", "Orders"], (req: cds.Request) => Catalog.run(req.query))

        return super.init()
    }
}
