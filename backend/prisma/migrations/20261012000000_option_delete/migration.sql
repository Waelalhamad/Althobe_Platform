-- Option types and values can be deleted (soft): a deleted one disappears from every list and
-- frees its name and code, while products deleted earlier keep pointing at it.

ALTER TABLE "option_groups" ADD COLUMN "deleted_at" TIMESTAMPTZ(3);
ALTER TABLE "option_values" ADD COLUMN "deleted_at" TIMESTAMPTZ(3);

-- Names and codes are unique among what is not deleted.
DROP INDEX "uq_option_groups_name_ar";
CREATE UNIQUE INDEX "uq_option_groups_name_ar" ON "option_groups"("name_ar") WHERE "deleted_at" IS NULL;

DROP INDEX "uq_option_values_group_parent_value";
DROP INDEX "uq_option_values_group_parent_code";
CREATE UNIQUE INDEX "uq_option_values_group_parent_value" ON "option_values"("group_id", "parent_id", "value_ar") NULLS NOT DISTINCT WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "uq_option_values_group_parent_code" ON "option_values"("group_id", "parent_id", "code") NULLS NOT DISTINCT WHERE "deleted_at" IS NULL;
