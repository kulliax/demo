# cds-csrf-cache sample

Two small CAP apps that show `cds-csrf-cache` in action end to end:

- **`data-service`** is the "protected backend": `CatalogService` requires a valid CSRF token for
  every write against `Orders` (reads, e.g. of `Products`, stay open), exactly like a real S/4
  OData service. See [`data-service/srv/csrfProtection.ts`](data-service/srv/csrfProtection.ts) and
  [`data-service/srv/server.ts`](data-service/srv/server.ts) for the (manual, framework-free) CSRF
  handshake - CAP itself doesn't validate incoming CSRF tokens for you; see the main
  [README](../README.md) for why an App Router is the standard way to get this for free instead.
- **`shop-service`** is the consumer: `ShopService` forwards to `CatalogService` over a
  destination-backed remote service connection - see
  [`shop-service/srv/shop-service.ts`](shop-service/srv/shop-service.ts), the only handler code this
  side needs. `cds-csrf-cache` is picked up automatically via its `cds-plugin.js` and
  fetches/caches the CSRF token `data-service` requires - nothing in `shop-service` calls the
  plugin, or even knows CSRF is involved.

Static reference data (`Products`) lives in
[`data-service/db/data/sample.data-Products.csv`](data-service/db/data/sample.data-Products.csv) -
there's no real backend behind this sample, just two local CAP apps.

## Run it

```sh
# terminal 1 - the protected backend
cd data-service && npm install && npm start

# terminal 2 - the consumer
cd shop-service && npm install && npm start
```

Then use [`../requests.http`](../requests.http) (VS Code REST Client, IntelliJ HTTP Client, ...) to
walk through both sides - or the equivalent `curl`:

```sh
# through shop-service: cds-csrf-cache handles the CSRF token invisibly
curl -X POST http://localhost:4004/odata/v4/shop/Orders \
  -H "content-type: application/json" \
  -d '{"product": "P01", "quantity": 2}'
```

Run that a few times in a row and watch **terminal 1** (`data-service`): it logs
`issued a csrf token` once, then no such line for any further call - the token is cached, not
re-fetched per write. **Terminal 2** (`shop-service`, with `cds.log` at `info` or lower, the
default) logs `csrf token cache attached to service 'CatalogService'` at startup and
`fetched a new csrf token` only on that first write.

Compare that with placing an order directly against `data-service` (request 2 vs. 3+4 in
[`../requests.http`](../requests.http)): without a token it's rejected with `403` and
`x-csrf-token: Required`; with one fetched and replayed by hand, it succeeds. `shop-service`'s
callers never have to do that dance themselves.

## What to look at

- [`data-service/srv/csrfProtection.ts`](data-service/srv/csrfProtection.ts) /
  [`data-service/srv/server.ts`](data-service/srv/server.ts) - the whole "backend requires CSRF"
  side, deliberately minimal (no `csurf`/App Router dependency) so it's easy to read end to end.
- [`shop-service/srv/shop-service.ts`](shop-service/srv/shop-service.ts) - the whole consumer: a
  plain projection onto the remote `CatalogService`, forwarded generically (CAP doesn't auto-forward
  CRUD for a pure projection onto a remote service, so this is the minimal handler it needs).
  `cds-csrf-cache`'s `before("*")` handler (attached by this package's `cds-plugin.js` when
  `CatalogService` is served, per its `csrf` config in
  [`shop-service/package.json`](shop-service/package.json)) injects the cached token/cookie into
  that outgoing request - nothing here calls the plugin directly.
- [`shop-service/srv/external/CatalogService.cds`](shop-service/srv/external/CatalogService.cds) -
  a hand-written stand-in for `CatalogService`'s metadata; a real project gets this via
  `cds import <edmx>` against the actual remote service.
