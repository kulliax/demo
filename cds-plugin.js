// Auto-detected and loaded by CAP's plugin loader (`cds serve` / `cds watch`) because this package
// is listed as a dependency and provides this exact file name next to its package.json
// (see capire docs "CDS Plugin Packages"). Wires the csrf token cache into every served
// destination-backed remote service - no service needs to call the plugin itself.
const cds = require("@sap/cds")

/**
 * Loaded lazily, inside the `served` handler, and never at plugin-load time: this file is required
 * by `cds-env` itself, i.e. by *every* tool that merely loads `@sap/cds` - `cds-typer`, `cds build`,
 * eslint - and those load it in a plain CJS runtime with no TypeScript loader registered, where a
 * top-level `require` of the compiled `./lib/attachCsrfCache.js` would otherwise run just as well,
 * but wrapping it keeps a missing/un-built `lib/` (e.g. before this package's own `npm run build`
 * has ever run) from taking down the whole host application - it just leaves CAP's default
 * per-request csrf handling in place.
 */
function loadAttachCsrfCache() {
    try {
        return require("./lib/attachCsrfCache").attachCsrfCache
    } catch (error) {
        cds.log("csrf-cache").error("could not load the csrf token cache, remote services keep CAP's per-request csrf handling", error)
        return undefined
    }
}

cds.on("served", all => {
    const attachCsrfCache = loadAttachCsrfCache()
    if (!attachCsrfCache) return

    for (const srv of Object.values(all))
        if (srv instanceof cds.RemoteService) attachCsrfCache(srv)
})
