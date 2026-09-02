using { CatalogService as Catalog } from './external/CatalogService';

/**
 * Forwards to CatalogService (../../data-service), which requires a CSRF token for writes.
 * cds-csrf-cache (attached automatically via its cds-plugin.js) fetches and caches that token, so
 * CREATE requests against Orders below never pay for a fresh token fetch after the first one - see
 * the main README for how to observe that caching in the logs.
 */
service ShopService {
    @readonly entity Products as projection on Catalog.Products;
    entity Orders as projection on Catalog.Orders;
}
