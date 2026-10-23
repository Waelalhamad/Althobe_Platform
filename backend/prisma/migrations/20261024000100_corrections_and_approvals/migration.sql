-- Developer report F-02 and F-03: receipts are corrected on the receipt itself, and a manual
-- adjustment has a fixed reason (each with its account) and, past a limit, a second person's
-- approval before it touches stock.

-- ─── Receipt corrections ───────────────────────────────────────────────────────────────────
-- RECEIPT_CORRECTION is signed (less or more of a received line) and always at a stated cost:
-- the line's own, so the books undo exactly what the receipt posted.
ALTER TABLE "inventory_movements" DROP CONSTRAINT "ck_inventory_movements_sign",
  ADD CONSTRAINT "ck_inventory_movements_sign" CHECK (
    ("type" IN ('OPENING', 'PURCHASE', 'RETURN', 'TRANSFER_IN') AND "quantity" > 0)
    OR ("type" IN ('SALE', 'TRANSFER_OUT', 'DAMAGE') AND "quantity" < 0)
    OR ("type" IN ('ADJUSTMENT', 'STOCKTAKE', 'RECEIPT_CORRECTION'))
  ),
  ADD CONSTRAINT "ck_inventory_movements_correction_cost" CHECK (
    "type" <> 'RECEIPT_CORRECTION' OR "unit_cost_amount" IS NOT NULL
  );

-- What a receipt was confirmed as (parties module, ADR-016 addendum): its corrections post to
-- the same place. Receipts confirmed before this have no row: they were owed with no name.
CREATE TABLE "receipt_terms" (
  "session_id" UUID         NOT NULL,
  "source"     TEXT         NOT NULL,
  "party_id"   UUID,
  "invoice_no" TEXT,
  "created_by" UUID         NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "receipt_terms_pkey" PRIMARY KEY ("session_id")
);
ALTER TABLE "receipt_terms"
  ADD CONSTRAINT "receipt_terms_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "scan_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "receipt_terms_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "receipt_terms_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_receipt_terms_source" CHECK ("source" IN ('SUPPLIER', 'CASH', 'OPENING', 'OWNER'));

-- A supplier's statement shows a correction of their bill.
ALTER TABLE "party_entries" DROP CONSTRAINT "ck_party_entries_kind",
  ADD CONSTRAINT "ck_party_entries_kind" CHECK ("kind" IN ('BILL', 'BILL_CORRECTION', 'PAYMENT', 'INVOICE', 'RECEIPT', 'POS_SALE', 'POS_REFUND'));

-- ─── Adjustment reasons and approvals ──────────────────────────────────────────────────────
-- Each reason has its account (accounting/inventory-posting.ts). Older adjustments keep NULL.
ALTER TABLE "inventory_movements"
  ADD COLUMN "reason_code" TEXT,
  ADD CONSTRAINT "ck_inventory_movements_reason_code" CHECK (
    "reason_code" IS NULL
    OR "reason_code" IN ('COUNT_DIFFERENCE', 'DAMAGE', 'SAMPLE', 'INTERNAL_USE', 'GIFT')
  );

-- An adjustment past the limit (any increase; or more than 3 pieces or 50 $ out) waits here
-- and changes nothing until someone else with inventory.adjust.approve accepts it.
CREATE TABLE "adjustment_requests" (
  "id"             UUID         NOT NULL,
  "variant_id"     UUID         NOT NULL,
  "location_id"    UUID         NOT NULL,
  "delta"          INTEGER      NOT NULL,
  "reason_code"    TEXT         NOT NULL,
  "note"           TEXT,
  -- USD cents at the average cost when asked, to show what is at stake.
  "value_estimate" BIGINT       NOT NULL,
  "status"         TEXT         NOT NULL DEFAULT 'PENDING',
  "requested_by"   UUID         NOT NULL,
  "requested_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_by"     UUID,
  "decided_at"     TIMESTAMPTZ(3),
  "decision_note"  TEXT,
  "movement_id"    UUID,
  CONSTRAINT "adjustment_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "idx_adjustment_requests_status" ON "adjustment_requests"("status", "requested_at" DESC);
ALTER TABLE "adjustment_requests"
  ADD CONSTRAINT "adjustment_requests_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "adjustment_requests_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "adjustment_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "adjustment_requests_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "adjustment_requests_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "inventory_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_adjustment_requests_delta" CHECK ("delta" <> 0),
  ADD CONSTRAINT "ck_adjustment_requests_status" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED')),
  ADD CONSTRAINT "ck_adjustment_requests_reason_code" CHECK ("reason_code" IN ('COUNT_DIFFERENCE', 'DAMAGE', 'SAMPLE', 'INTERNAL_USE', 'GIFT')),
  -- The person who asks is never the one who approves.
  ADD CONSTRAINT "ck_adjustment_requests_four_eyes" CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by");
