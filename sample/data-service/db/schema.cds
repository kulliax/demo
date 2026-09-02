namespace sample.data;

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
