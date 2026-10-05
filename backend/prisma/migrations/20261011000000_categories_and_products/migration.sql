-- Category → product → size (owner, 2026-10-11; ADR-011).
--   categories  ثوب، طقم … (a tree, up to three levels); each uses some option types
--   products    one design in a category: one value per option type except the size
--   variants    one size of a product: its own barcode and stock (unchanged ids, barcodes, SKUs)
-- What used to be a "product" (ثوب, طقم) becomes a category. Existing variants are grouped into
-- products by their non-size values. No stock exists on the real database at this point.

-- ─── 1. products → categories ─────────────────────────────────────────────────────────────────

ALTER TABLE "products" RENAME TO "categories";
ALTER TABLE "categories" RENAME CONSTRAINT "products_pkey" TO "categories_pkey";
ALTER INDEX "uq_products_code" RENAME TO "uq_categories_code";
ALTER TABLE "categories" ADD COLUMN "parent_id" UUID;
ALTER TABLE "categories" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "categories" ADD CONSTRAINT "ck_categories_not_own_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
CREATE INDEX "idx_categories_parent_id" ON "categories"("parent_id");
UPDATE "categories" c SET "sort_order" = 10 * n.rn
FROM (SELECT "id", row_number() OVER (ORDER BY "created_at") AS rn FROM "categories") n
WHERE n."id" = c."id";

ALTER TABLE "product_option_groups" RENAME TO "category_option_groups";
ALTER TABLE "category_option_groups" RENAME COLUMN "product_id" TO "category_id";
ALTER TABLE "category_option_groups" RENAME CONSTRAINT "product_option_groups_pkey" TO "category_option_groups_pkey";
ALTER TABLE "category_option_groups" RENAME CONSTRAINT "product_option_groups_product_id_fkey" TO "category_option_groups_category_id_fkey";
ALTER TABLE "category_option_groups" RENAME CONSTRAINT "product_option_groups_group_id_fkey" TO "category_option_groups_group_id_fkey";
ALTER INDEX "idx_product_option_groups_group_id" RENAME TO "idx_category_option_groups_group_id";

-- Category codes are suggested from the name now; the P-0001 sequence is no longer used.
DROP SEQUENCE "product_code_seq";

-- ─── 2. products: one design per category ─────────────────────────────────────────────────────

CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "style_key" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_products_code" ON "products"("code");
CREATE UNIQUE INDEX "uq_products_category_style" ON "products"("category_id", "style_key");
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "product_style_values" (
    "product_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "value_id" UUID NOT NULL,

    CONSTRAINT "product_style_values_pkey" PRIMARY KEY ("product_id","group_id")
);
CREATE INDEX "idx_product_style_values_value_id" ON "product_style_values"("value_id");
ALTER TABLE "product_style_values" ADD CONSTRAINT "product_style_values_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_style_values" ADD CONSTRAINT "product_style_values_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "option_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_style_values" ADD CONSTRAINT "product_style_values_value_id_group_id_fkey" FOREIGN KEY ("value_id", "group_id") REFERENCES "option_values"("id", "group_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Product-level selling prices; variant_prices stays as a per-size override (ADR-009).
CREATE TABLE "product_prices" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "list" "price_list" NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_prices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_product_prices_product_list" ON "product_prices"("product_id", "list");
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "product_prices"
  ADD CONSTRAINT "ck_product_prices_amount" CHECK ("amount" >= 0),
  ADD CONSTRAINT "ck_product_prices_currency" CHECK ("currency" IN ('SYP', 'USD'));

-- ─── 3. Group existing variants into products ────────────────────────────────────────────────

-- Each variant's non-size values, as the product's style key.
CREATE TEMPORARY TABLE "_variant_style" ON COMMIT DROP AS
SELECT v."id" AS variant_id, v."product_id" AS category_id,
       coalesce((SELECT string_agg(ov."value_id"::text, ',' ORDER BY ov."value_id"::text COLLATE "C")
                 FROM "variant_option_values" ov
                 JOIN "option_groups" g ON g."id" = ov."group_id"
                 WHERE ov."variant_id" = v."id" AND g."key" IS DISTINCT FROM 'SIZE'), '') AS style_key,
       v."deleted_at", v."is_active"
FROM "product_variants" v;

CREATE TEMPORARY TABLE "_new_products" ON COMMIT DROP AS
SELECT gen_random_uuid() AS id, s.category_id, s.style_key,
       c."code" || '-' || lpad((row_number() OVER (PARTITION BY s.category_id ORDER BY s.style_key))::text, 3, '0') AS code,
       bool_and(s."deleted_at" IS NOT NULL) AS all_deleted,
       bool_or(s."is_active") AS any_active
FROM "_variant_style" s
JOIN "categories" c ON c."id" = s.category_id
GROUP BY s.category_id, s.style_key, c."code";

INSERT INTO "products" ("id", "category_id", "code", "style_key", "is_active", "updated_at", "deleted_at")
SELECT id, category_id, code, style_key, any_active, now(), CASE WHEN all_deleted THEN now() END
FROM "_new_products";

INSERT INTO "product_style_values" ("product_id", "group_id", "value_id")
SELECT DISTINCT np.id, ov."group_id", ov."value_id"
FROM "_variant_style" s
JOIN "_new_products" np ON np.category_id = s.category_id AND np.style_key = s.style_key
JOIN "variant_option_values" ov ON ov."variant_id" = s.variant_id
JOIN "option_groups" g ON g."id" = ov."group_id"
WHERE g."key" IS DISTINCT FROM 'SIZE';

-- Variants now belong to the product; only the size stays on the variant.
ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_product_id_fkey";
UPDATE "product_variants" v
SET "product_id" = np.id
FROM "_variant_style" s
JOIN "_new_products" np ON np.category_id = s.category_id AND np.style_key = s.style_key
WHERE s.variant_id = v."id";
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DELETE FROM "variant_option_values" ov
USING "option_groups" g
WHERE g."id" = ov."group_id" AND g."key" IS DISTINCT FROM 'SIZE';

-- The variant's key is now just its size value ('' for a category without sizes).
UPDATE "product_variants" v
SET "option_key" = coalesce((SELECT ov."value_id"::text FROM "variant_option_values" ov WHERE ov."variant_id" = v."id"), '');

-- ─── 4. Photos belong to products (designs); tags are no longer needed ──────────────────────

-- Photos were per category before; none are in use on the real or practice database.
DROP TABLE "product_photo_values";
DELETE FROM "product_photos";
ALTER TABLE "product_photos" DROP CONSTRAINT "product_photos_product_id_fkey";
ALTER TABLE "product_photos" ADD CONSTRAINT "product_photos_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
