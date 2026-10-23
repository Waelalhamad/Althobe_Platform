-- Gifts (developer report F-06; owner, 2026-10-23: only the owner gives them, no approval).
-- A gift is a GIFT scan session confirmed with who received it and why. Its pieces leave stock
-- as GIFT movements, posted to 5212 هدايا وإكراميات at the average cost.

-- GIFT takes stock away; undone, it puts it back.
ALTER TABLE "inventory_movements" DROP CONSTRAINT "ck_inventory_movements_sign",
  ADD CONSTRAINT "ck_inventory_movements_sign" CHECK (
    ("type" IN ('OPENING', 'PURCHASE', 'RETURN', 'TRANSFER_IN') AND "quantity" > 0)
    OR ("type" IN ('SALE', 'TRANSFER_OUT', 'DAMAGE', 'GIFT') AND "quantity" < 0)
    OR ("type" IN ('ADJUSTMENT', 'STOCKTAKE', 'RECEIPT_CORRECTION'))
    OR ("type" IN ('DAMAGE', 'GIFT') AND "reverses_id" IS NOT NULL)
  ),
  DROP CONSTRAINT "ck_inventory_movements_undo_type",
  ADD CONSTRAINT "ck_inventory_movements_undo_type" CHECK (
    "reverses_id" IS NULL OR "type" IN ('ADJUSTMENT', 'DAMAGE', 'GIFT')
  );

-- Who receives gifts, kept once so the same shipper is not typed three ways.
CREATE TABLE "gift_recipients" (
  "id"         UUID         NOT NULL,
  "name"       TEXT         NOT NULL,
  "kind"       TEXT         NOT NULL,
  "phone"      TEXT,
  "created_by" UUID         NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gift_recipients_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "gift_recipients"
  ADD CONSTRAINT "gift_recipients_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_gift_recipients_kind" CHECK ("kind" IN ('SHIPPING', 'CUSTOMER', 'WHOLESALE', 'INFLUENCER', 'OFFICIAL', 'EMPLOYEE', 'OTHER')),
  ADD CONSTRAINT "ck_gift_recipients_name" CHECK (btrim("name") <> '');
CREATE UNIQUE INDEX "uq_gift_recipients_name" ON "gift_recipients" (lower(btrim("name")));

CREATE TABLE "gifts" (
  "session_id"   UUID         NOT NULL,
  "recipient_id" UUID         NOT NULL,
  "occasion"     TEXT         NOT NULL,
  -- A shipment or order it went with, as written on it.
  "reference"    TEXT,
  -- The delivery receipt photo in S3 (same private bucket as product photos).
  "photo_key"    TEXT,
  "created_by"   UUID         NOT NULL,
  "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gifts_pkey" PRIMARY KEY ("session_id")
);
ALTER TABLE "gifts"
  ADD CONSTRAINT "gifts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "scan_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gifts_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "gift_recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gifts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_gifts_occasion" CHECK (btrim("occasion") <> '');
CREATE INDEX "idx_gifts_recipient" ON "gifts" ("recipient_id", "created_at");
