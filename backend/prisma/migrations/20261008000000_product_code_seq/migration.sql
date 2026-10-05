-- Product codes are generated: P-0001, P-0002, … (the owner asked for automatic codes).
-- Allocated by the database, never by application code, like barcodes.
CREATE SEQUENCE "product_code_seq" AS BIGINT START WITH 1 MINVALUE 1 NO CYCLE;
