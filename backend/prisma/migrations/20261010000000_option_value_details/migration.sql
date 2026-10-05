-- Option values form a tree (owner, 2026-10-10): a value may have details under it, up to three
-- levels — القماش → جوخ هندي → مونس / مشخط / ساده. A variant picks the deepest value.

-- AlterTable
ALTER TABLE "option_values" ADD COLUMN "parent_id" UUID;

-- A detail sits under a value of the same type (composite key: id + group).
ALTER TABLE "option_values" ADD CONSTRAINT "option_values_parent_id_group_id_fkey" FOREIGN KEY ("parent_id", "group_id") REFERENCES "option_values"("id", "group_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Names and codes are unique among siblings: سادة may exist under two fabrics. NULLS NOT DISTINCT
-- keeps the top level unique too (Prisma's schema cannot express it; the index is the rule).
DROP INDEX "uq_option_values_group_value";
DROP INDEX "uq_option_values_group_code";
CREATE UNIQUE INDEX "uq_option_values_group_parent_value" ON "option_values"("group_id", "parent_id", "value_ar") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX "uq_option_values_group_parent_code" ON "option_values"("group_id", "parent_id", "code") NULLS NOT DISTINCT;

CREATE INDEX "idx_option_values_parent_id" ON "option_values"("parent_id");

ALTER TABLE "option_values" ADD CONSTRAINT "ck_option_values_not_own_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
