-- Re-audit of 2026-10-24.
--
-- 1. With nobody else who may approve, the person who asked may approve their own adjustment or
--    count, and it is recorded as such (self_approved / applied_alone). Otherwise four eyes stay.
ALTER TABLE "adjustment_requests"
  ADD COLUMN "self_approved" BOOLEAN NOT NULL DEFAULT false,
  DROP CONSTRAINT "ck_adjustment_requests_four_eyes",
  ADD CONSTRAINT "ck_adjustment_requests_four_eyes" CHECK (
    "decided_by" IS NULL OR "decided_by" <> "requested_by" OR "self_approved"
  );
ALTER TABLE "stocktakes" ADD COLUMN "applied_alone" BOOLEAN NOT NULL DEFAULT false;

-- 2. The two "in transit" accounts say what each holds: the goods on the road between branches,
--    and the account each transfer passes through (per branch: what one holds for the other).
UPDATE "gl_accounts" SET "name_ar" = 'تحويلات بين المواقع والفروع'
WHERE "system_role" = 'INVENTORY_TRANSIT';
UPDATE "gl_accounts" SET "name_ar" = 'بضاعة بالطريق — شحنات بين الفروع'
WHERE "location_id" = (SELECT "id" FROM "locations" WHERE "kind" = 'TRANSIT');
