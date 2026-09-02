/**
 * Minimal stand-in for CatalogService's (../../data-service) real metadata, just enough for CAP to
 * build requests against it. A real project gets this via `cds import <edmx>` against the actual
 * remote service instead of hand-writing it.
 */
service CatalogService {
    entity Products {
        key ID    : String(10);
            title : String(111);
            price : Decimal(9, 2);
    }
    entity Orders {
        key ID       : UUID;
            product  : String(10);
            quantity : Integer;
    }
}
