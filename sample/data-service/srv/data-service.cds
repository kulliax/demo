using { sample.data as my } from '../db/schema';

/**
 * The demo's "protected" backend: Products is plain reference data, Orders requires a valid CSRF
 * token for every write (see server.ts) - exactly like a real S/4 OData service.
 */
service CatalogService {
    @readonly entity Products as projection on my.Products;
    entity Orders as projection on my.Orders;
}
