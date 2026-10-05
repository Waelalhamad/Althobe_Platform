-- Selling prices per variant (ADR-009), and the option types of the suit (الطقم).

-- CreateEnum
CREATE TYPE "price_list" AS ENUM ('RETAIL', 'WHOLESALE');

-- CreateTable
CREATE TABLE "variant_prices" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "list" "price_list" NOT NULL,
    "amount" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "variant_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_variant_prices_variant_list" ON "variant_prices"("variant_id", "list");

-- AddForeignKey
ALTER TABLE "variant_prices" ADD CONSTRAINT "variant_prices_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Money rules (ADR-004): never negative, and only the supported currencies.
ALTER TABLE "variant_prices"
  ADD CONSTRAINT "ck_variant_prices_amount" CHECK ("amount" >= 0),
  ADD CONSTRAINT "ck_variant_prices_currency" CHECK ("currency" IN ('SYP', 'USD'));

-- ─── The suit (الطقم): model and number of pieces (owner, 2026-10-05) ─────────────────────────
-- Placed first, so a suit reads "رسمي · 3 قطع · تويوبو صيني · …". Thobes do not use them.
-- ON CONFLICT: the owner may already have added them on the Options page.

INSERT INTO "option_groups" ("id", "name_ar", "sort_order", "updated_at") VALUES
  (gen_random_uuid(), 'موديل الطقم', 1, now()),
  (gen_random_uuid(), 'عدد القطع',   2, now())
ON CONFLICT ("name_ar") DO NOTHING;

INSERT INTO "option_values" ("id", "group_id", "value_ar", "sort_order", "updated_at")
SELECT gen_random_uuid(), g."id", v.value_ar, v.sort_order, now()
FROM (VALUES
  ('موديل الطقم', 'سفاري',  10),
  ('موديل الطقم', 'رسمي',   20),
  ('عدد القطع',   'قطعتان', 10),
  ('عدد القطع',   '3 قطع',  20)
) AS v(group_name, value_ar, sort_order)
JOIN "option_groups" g ON g."name_ar" = v.group_name
ON CONFLICT ("group_id", "value_ar") DO NOTHING;

-- تويوبو صيني is the suit's fabric; it exists since product_options unless it was renamed.
INSERT INTO "option_values" ("id", "group_id", "value_ar", "sort_order", "updated_at")
SELECT gen_random_uuid(), g."id", 'تويوبو صيني', 20, now()
FROM "option_groups" g
WHERE g."key" = 'FABRIC'
ON CONFLICT ("group_id", "value_ar") DO NOTHING;
