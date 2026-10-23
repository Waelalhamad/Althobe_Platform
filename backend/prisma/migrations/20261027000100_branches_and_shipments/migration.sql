-- Libya as a branch (developer report F-04; owner, 2026-10-23: shipments take days and Libya
-- confirms what arrived; someone in Libya works in the system; the Libya warehouse is empty).

-- ─── Every location belongs to a branch; goods on the road belong to none ─────────────────
ALTER TABLE "locations" ADD COLUMN "branch" CHAR(2);
UPDATE "locations" SET "branch" = 'SY';
-- The second warehouse is the Libya warehouse.
UPDATE "locations" SET "branch" = 'LY', "name_ar" = 'مستودع ليبيا' WHERE "code" = 'WH2';
INSERT INTO "locations" ("id", "code", "name_ar", "kind", "branch", "updated_at")
VALUES (gen_random_uuid(), 'TRANSIT', 'بالطريق — شحنات بين الفروع', 'TRANSIT', NULL, CURRENT_TIMESTAMP);
ALTER TABLE "locations"
  ADD CONSTRAINT "ck_locations_branch" CHECK (
    ("kind" = 'TRANSIT' AND "branch" IS NULL)
    OR ("kind" <> 'TRANSIT' AND "branch" IN ('SY', 'LY'))
  );
CREATE UNIQUE INDEX "uq_locations_one_transit" ON "locations" ("kind") WHERE "kind" = 'TRANSIT';

-- The Libya warehouse's stock account is Libya's.
UPDATE "gl_accounts" SET "branch" = 'LY', "name_ar" = 'مخزون مستودع ليبيا'
WHERE "location_id" = (SELECT "id" FROM "locations" WHERE "code" = 'WH2');

-- A user may be kept to one branch: they see and move only its stock. NULL: every branch.
ALTER TABLE "users"
  ADD COLUMN "branch" CHAR(2),
  ADD CONSTRAINT "ck_users_branch" CHECK ("branch" IS NULL OR "branch" IN ('SY', 'LY'));

-- Lost in shipping takes stock away, from goods on the road only.
ALTER TABLE "inventory_movements" DROP CONSTRAINT "ck_inventory_movements_sign",
  ADD CONSTRAINT "ck_inventory_movements_sign" CHECK (
    ("type" IN ('OPENING', 'PURCHASE', 'RETURN', 'TRANSFER_IN') AND "quantity" > 0)
    OR ("type" IN ('SALE', 'TRANSFER_OUT', 'DAMAGE', 'GIFT', 'SHIPPING_LOSS') AND "quantity" < 0)
    OR ("type" IN ('ADJUSTMENT', 'STOCKTAKE', 'RECEIPT_CORRECTION'))
    OR ("type" IN ('DAMAGE', 'GIFT') AND "reverses_id" IS NOT NULL)
  );

-- ─── Shipments between branches ─────────────────────────────────────────────────────────────
-- Sent: the pieces leave the sender for the road (TRANSIT). Received: what arrived enters the
-- destination at the value it travelled at; what did not arrive is lost in shipping.
CREATE TABLE "shipments" (
  "id"                 UUID         NOT NULL,
  "number"             SERIAL       NOT NULL,
  "from_location_id"   UUID         NOT NULL,
  "to_location_id"     UUID         NOT NULL,
  "status"             TEXT         NOT NULL DEFAULT 'IN_TRANSIT',
  "send_session_id"    UUID         NOT NULL,
  "receive_session_id" UUID,
  "note"               TEXT,
  "sent_by"            UUID         NOT NULL,
  "sent_at"            TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "received_by"        UUID,
  "received_at"        TIMESTAMPTZ(3),
  CONSTRAINT "shipments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_shipments_status" CHECK ("status" IN ('IN_TRANSIT', 'RECEIVED')),
  CONSTRAINT "ck_shipments_received" CHECK (
    ("status" = 'RECEIVED') = ("received_at" IS NOT NULL AND "received_by" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "uq_shipments_number" ON "shipments" ("number");
CREATE UNIQUE INDEX "uq_shipments_send_session" ON "shipments" ("send_session_id");
CREATE UNIQUE INDEX "uq_shipments_receive_session" ON "shipments" ("receive_session_id");
CREATE INDEX "idx_shipments_status" ON "shipments" ("status", "sent_at");
ALTER TABLE "shipments"
  ADD CONSTRAINT "shipments_from_location_id_fkey" FOREIGN KEY ("from_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "shipments_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "shipments_send_session_id_fkey" FOREIGN KEY ("send_session_id") REFERENCES "scan_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "shipments_receive_session_id_fkey" FOREIGN KEY ("receive_session_id") REFERENCES "scan_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "shipments_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "shipments_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "shipment_lines" (
  "shipment_id"       UUID    NOT NULL,
  "variant_id"        UUID    NOT NULL,
  "sent_quantity"     INTEGER NOT NULL,
  -- Set when the shipment is received; sent minus received was lost in shipping.
  "received_quantity" INTEGER,
  CONSTRAINT "shipment_lines_pkey" PRIMARY KEY ("shipment_id", "variant_id"),
  CONSTRAINT "ck_shipment_lines_quantities" CHECK (
    "sent_quantity" > 0
    AND ("received_quantity" IS NULL OR "received_quantity" BETWEEN 0 AND "sent_quantity")
  )
);
ALTER TABLE "shipment_lines"
  ADD CONSTRAINT "shipment_lines_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "shipment_lines_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
