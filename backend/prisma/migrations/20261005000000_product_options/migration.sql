-- Configurable variant options (ADR-008). The fixed fabric / colour / size columns become option
-- types and values the owner edits. Every existing variant keeps its id, barcode and stock.

-- CreateTable
CREATE TABLE "option_groups" (
    "id" UUID NOT NULL,
    "key" TEXT,
    "name_ar" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "option_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "option_values" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "value_ar" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "option_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_option_groups" (
    "product_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,

    CONSTRAINT "product_option_groups_pkey" PRIMARY KEY ("product_id","group_id")
);

-- CreateTable
CREATE TABLE "variant_option_values" (
    "variant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "value_id" UUID NOT NULL,

    CONSTRAINT "variant_option_values_pkey" PRIMARY KEY ("variant_id","group_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_option_groups_key" ON "option_groups"("key");

-- CreateIndex
CREATE UNIQUE INDEX "uq_option_groups_name_ar" ON "option_groups"("name_ar");

-- CreateIndex
CREATE UNIQUE INDEX "uq_option_values_group_value" ON "option_values"("group_id", "value_ar");

-- CreateIndex
CREATE UNIQUE INDEX "uq_option_values_id_group" ON "option_values"("id", "group_id");

-- CreateIndex
CREATE INDEX "idx_product_option_groups_group_id" ON "product_option_groups"("group_id");

-- CreateIndex
CREATE INDEX "idx_variant_option_values_value_id" ON "variant_option_values"("value_id");

-- AddForeignKey
ALTER TABLE "option_values" ADD CONSTRAINT "option_values_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "option_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option_groups" ADD CONSTRAINT "product_option_groups_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option_groups" ADD CONSTRAINT "product_option_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "option_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_option_values" ADD CONSTRAINT "variant_option_values_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_option_values" ADD CONSTRAINT "variant_option_values_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "option_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_option_values" ADD CONSTRAINT "variant_option_values_value_id_group_id_fkey" FOREIGN KEY ("value_id", "group_id") REFERENCES "option_values"("id", "group_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Starting lists (confirmed by the owner, 2026-10-05). Editable in the app afterwards. ──────

INSERT INTO "option_groups" ("id", "key", "name_ar", "sort_order", "updated_at") VALUES
  (gen_random_uuid(), 'CUT',    'القصة',  10, now()),
  (gen_random_uuid(), 'BUTTON', 'الزر',   20, now()),
  (gen_random_uuid(), 'ZIPPER', 'السحاب', 30, now()),
  (gen_random_uuid(), 'SLEEVE', 'الكم',   40, now()),
  (gen_random_uuid(), 'FABRIC', 'القماش', 50, now()),
  (gen_random_uuid(), 'COLOUR', 'اللون',  60, now()),
  (gen_random_uuid(), 'SIZE',   'القياس', 70, now());

INSERT INTO "option_values" ("id", "group_id", "value_ar", "sort_order", "updated_at")
SELECT gen_random_uuid(), g."id", v.value_ar, v.sort_order, now()
FROM (VALUES
  ('CUT',    'سعودية',      10),
  ('CUT',    'خليجية',      20),
  ('BUTTON', 'ملكي',        10),
  ('BUTTON', 'معدن',        20),
  ('BUTTON', 'بلاستيك',     30),
  ('ZIPPER', 'مدفون',       10),
  ('SLEEVE', 'سنارة',       10),
  ('SLEEVE', 'فلت/كويتي',   20),
  ('FABRIC', 'جوخ هندي',    10),
  ('FABRIC', 'تويوبو صيني', 20)
) AS v(group_key, value_ar, sort_order)
JOIN "option_groups" g ON g."key" = v.group_key;

-- ─── Existing variants: their fabric / colour / size become values of those types ─────────────

INSERT INTO "option_values" ("id", "group_id", "value_ar", "sort_order", "updated_at")
SELECT gen_random_uuid(), g."id", x.value_ar,
       100 + 10 * row_number() OVER (PARTITION BY x.group_key ORDER BY x.value_ar), now()
FROM (
  SELECT DISTINCT 'FABRIC' AS group_key, "fabric" AS value_ar FROM "product_variants"
  UNION SELECT DISTINCT 'COLOUR', "colour" FROM "product_variants"
  UNION SELECT DISTINCT 'SIZE', "size" FROM "product_variants"
) x
JOIN "option_groups" g ON g."key" = x.group_key
ON CONFLICT ("group_id", "value_ar") DO NOTHING;

-- Products made so far were built from fabric × colour × size.
INSERT INTO "product_option_groups" ("product_id", "group_id")
SELECT p."id", g."id"
FROM "products" p
CROSS JOIN "option_groups" g
WHERE g."key" IN ('FABRIC', 'COLOUR', 'SIZE');

INSERT INTO "variant_option_values" ("variant_id", "group_id", "value_id")
SELECT v."id", g."id", o."id"
FROM "product_variants" v
JOIN "option_groups" g ON g."key" IN ('FABRIC', 'COLOUR', 'SIZE')
JOIN "option_values" o ON o."group_id" = g."id"
  AND o."value_ar" = CASE g."key" WHEN 'FABRIC' THEN v."fabric"
                                  WHEN 'COLOUR' THEN v."colour"
                                  ELSE v."size" END;

-- AlterTable: the option key replaces the three columns as the duplicate guard.
ALTER TABLE "product_variants" ADD COLUMN "option_key" TEXT;

-- COLLATE "C": the application sorts the ids by code point; both sides must agree.
UPDATE "product_variants" v
SET "option_key" = k.option_key
FROM (
  SELECT "variant_id", string_agg("value_id"::text, ',' ORDER BY "value_id"::text COLLATE "C") AS option_key
  FROM "variant_option_values"
  GROUP BY "variant_id"
) k
WHERE k."variant_id" = v."id";

ALTER TABLE "product_variants" ALTER COLUMN "option_key" SET NOT NULL;

-- DropIndex
DROP INDEX "uq_product_variants_attributes";

-- AlterTable
ALTER TABLE "product_variants" DROP COLUMN "fabric",
DROP COLUMN "colour",
DROP COLUMN "size";

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_variants_option_key" ON "product_variants"("product_id", "option_key");
