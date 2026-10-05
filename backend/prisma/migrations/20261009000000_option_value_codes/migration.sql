-- Readable SKUs (owner, 2026-10-09): each option value gets a short Latin code, and a new
-- variant's SKU is the product code plus its values' codes: THB-SA-RY-MD-SN-JH-WH-56.

ALTER TABLE "option_values" ADD COLUMN "code" TEXT;

-- The starting lists get chosen codes.
UPDATE "option_values" o
SET "code" = c.code
FROM (VALUES
  ('سعودية', 'SA'), ('خليجية', 'GU'),
  ('ملكي', 'RY'), ('معدن', 'MT'), ('بلاستيك', 'PL'),
  ('مدفون', 'MD'),
  ('سنارة', 'SN'), ('فلت/كويتي', 'FK'),
  ('جوخ هندي', 'JH'), ('تويوبو صيني', 'TC'), ('قطني', 'CT'),
  ('أبيض', 'WH'), ('أسود', 'BK'), ('بيج', 'BG'), ('رمادي', 'GR'), ('كحلي', 'NV'),
  ('سفاري', 'SF'), ('رسمي', 'FM'),
  ('قطعتان', '2P'), ('3 قطع', '3P')
) AS c(value_ar, code)
WHERE o."value_ar" = c.value_ar;

-- Numbers (sizes) are their own code.
UPDATE "option_values" SET "code" = "value_ar" WHERE "code" IS NULL AND "value_ar" ~ '^[0-9]{1,6}$';

-- Anything else added since: V1, V2, … within its type, to be renamed on the Options page.
UPDATE "option_values" o
SET "code" = 'V' || n.rn
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "group_id" ORDER BY "sort_order", "value_ar") AS rn
  FROM "option_values" WHERE "code" IS NULL
) n
WHERE o."id" = n."id";

ALTER TABLE "option_values" ALTER COLUMN "code" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "uq_option_values_group_code" ON "option_values"("group_id", "code");

ALTER TABLE "option_values"
  ADD CONSTRAINT "ck_option_values_code" CHECK ("code" ~ '^[A-Z0-9]{1,6}$');
