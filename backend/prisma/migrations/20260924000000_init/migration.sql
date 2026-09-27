-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "unit_of_measure" AS ENUM ('PIECE', 'BOX', 'METER', 'KG');

-- CreateEnum
CREATE TYPE "location_kind" AS ENUM ('WAREHOUSE', 'STORE');

-- CreateEnum
CREATE TYPE "movement_type" AS ENUM ('OPENING', 'PURCHASE', 'SALE', 'RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT', 'DAMAGE', 'STOCKTAKE');

-- CreateEnum
CREATE TYPE "reference_type" AS ENUM ('OPENING', 'SCAN_SESSION', 'STOCKTAKE', 'MANUAL', 'TRANSFER', 'GOODS_RECEIPT', 'PURCHASE_ORDER', 'SALES_ORDER', 'RETURN');

-- CreateEnum
CREATE TYPE "reservation_status" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "scan_session_kind" AS ENUM ('OPENING', 'RECEIVE', 'TRANSFER', 'DAMAGE');

-- CreateEnum
CREATE TYPE "scan_session_status" AS ENUM ('OPEN', 'COMMITTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "stocktake_scope" AS ENUM ('FULL', 'PARTIAL');

-- CreateEnum
CREATE TYPE "stocktake_status" AS ENUM ('DRAFT', 'COUNTING', 'REVIEW', 'APPLIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "external_barcode_kind" AS ENUM ('GTIN', 'SUPPLIER');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT,
    "unit_of_measure" "unit_of_measure" NOT NULL DEFAULT 'PIECE',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "barcode" CHAR(13) NOT NULL,
    "fabric" TEXT NOT NULL,
    "colour" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_barcodes" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "barcode" TEXT NOT NULL,
    "kind" "external_barcode_kind" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variant_barcodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "name_en" TEXT,
    "kind" "location_kind" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_balances" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved_quantity" INTEGER NOT NULL DEFAULT 0,
    "value_base_amount" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "variant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "type" "movement_type" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "reference_type" "reference_type" NOT NULL,
    "reference_id" UUID,
    "transfer_id" UUID,
    "reason" TEXT,
    "note" TEXT,
    "unit_cost_amount" BIGINT,
    "unit_cost_currency" CHAR(3),
    "rate_to_base" DECIMAL(18,6),
    "unit_cost_base_amount" BIGINT NOT NULL,
    "value_base_amount" BIGINT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotency_key" TEXT,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "reservation_status" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(3),
    "released_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_sessions" (
    "id" UUID NOT NULL,
    "kind" "scan_session_kind" NOT NULL,
    "status" "scan_session_status" NOT NULL DEFAULT 'OPEN',
    "location_id" UUID NOT NULL,
    "to_location_id" UUID,
    "reason" TEXT,
    "note" TEXT,
    "created_by" UUID NOT NULL,
    "committed_by" UUID,
    "committed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scan_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_session_lines" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "unit_cost_amount" BIGINT,
    "unit_cost_currency" CHAR(3),
    "rate_to_base" DECIMAL(18,6),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scan_session_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_session_events" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "scan_id" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "variant_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_session_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktakes" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "scope" "stocktake_scope" NOT NULL,
    "status" "stocktake_status" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "snapshot_at" TIMESTAMPTZ(3),
    "snapshot_seq" BIGINT,
    "created_by" UUID NOT NULL,
    "applied_by" UUID,
    "applied_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stocktakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktake_lines" (
    "id" UUID NOT NULL,
    "stocktake_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "expected_quantity" INTEGER NOT NULL DEFAULT 0,
    "counted_quantity" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stocktake_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktake_scan_events" (
    "id" UUID NOT NULL,
    "stocktake_id" UUID NOT NULL,
    "scan_id" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "variant_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stocktake_scan_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_users_email" ON "users"("email");

-- CreateIndex
CREATE INDEX "idx_audit_logs_entity" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "idx_audit_logs_actor_created" ON "audit_logs"("actor_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_idempotency_records_expires_at" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_idempotency_records_key_operation" ON "idempotency_records"("key", "operation");

-- CreateIndex
CREATE UNIQUE INDEX "uq_products_code" ON "products"("code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_variants_sku" ON "product_variants"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_variants_barcode" ON "product_variants"("barcode");

-- CreateIndex
CREATE INDEX "idx_product_variants_product_id" ON "product_variants"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_variants_attributes" ON "product_variants"("product_id", "fabric", "colour", "size");

-- CreateIndex
CREATE UNIQUE INDEX "uq_variant_barcodes_barcode" ON "variant_barcodes"("barcode");

-- CreateIndex
CREATE INDEX "idx_variant_barcodes_variant_id" ON "variant_barcodes"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_locations_code" ON "locations"("code");

-- CreateIndex
CREATE INDEX "idx_inventory_balances_location_id" ON "inventory_balances"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_inventory_balances_variant_location" ON "inventory_balances"("variant_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_inventory_movements_seq" ON "inventory_movements"("seq");

-- CreateIndex
CREATE INDEX "idx_inventory_movements_variant_location_seq" ON "inventory_movements"("variant_id", "location_id", "seq" DESC);

-- CreateIndex
CREATE INDEX "idx_inventory_movements_location_seq" ON "inventory_movements"("location_id", "seq");

-- CreateIndex
CREATE INDEX "idx_inventory_movements_reference" ON "inventory_movements"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "idx_inventory_movements_transfer_id" ON "inventory_movements"("transfer_id");

-- CreateIndex
CREATE INDEX "idx_reservations_variant_location_status" ON "reservations"("variant_id", "location_id", "status");

-- CreateIndex
CREATE INDEX "idx_reservations_order_id" ON "reservations"("order_id");

-- CreateIndex
CREATE INDEX "idx_scan_sessions_status_location" ON "scan_sessions"("status", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_scan_session_lines_session_variant" ON "scan_session_lines"("session_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_scan_session_events_session_scan" ON "scan_session_events"("session_id", "scan_id");

-- CreateIndex
CREATE INDEX "idx_stocktakes_location_status" ON "stocktakes"("location_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_stocktake_lines_stocktake_variant" ON "stocktake_lines"("stocktake_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_stocktake_scan_events_stocktake_scan" ON "stocktake_scan_events"("stocktake_id", "scan_id");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_barcodes" ADD CONSTRAINT "variant_barcodes_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_sessions" ADD CONSTRAINT "scan_sessions_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_sessions" ADD CONSTRAINT "scan_sessions_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_sessions" ADD CONSTRAINT "scan_sessions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_sessions" ADD CONSTRAINT "scan_sessions_committed_by_fkey" FOREIGN KEY ("committed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_session_lines" ADD CONSTRAINT "scan_session_lines_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "scan_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_session_lines" ADD CONSTRAINT "scan_session_lines_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_session_events" ADD CONSTRAINT "scan_session_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "scan_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_session_events" ADD CONSTRAINT "scan_session_events_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_session_events" ADD CONSTRAINT "scan_session_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktakes" ADD CONSTRAINT "stocktakes_applied_by_fkey" FOREIGN KEY ("applied_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_stocktake_id_fkey" FOREIGN KEY ("stocktake_id") REFERENCES "stocktakes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_lines" ADD CONSTRAINT "stocktake_lines_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_scan_events" ADD CONSTRAINT "stocktake_scan_events_stocktake_id_fkey" FOREIGN KEY ("stocktake_id") REFERENCES "stocktakes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_scan_events" ADD CONSTRAINT "stocktake_scan_events_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_scan_events" ADD CONSTRAINT "stocktake_scan_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Business rules enforced by the database (docs/database.md: "if a rule can be a constraint, it is
-- a constraint"). Written by hand; Prisma cannot express these.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- Stock can never go negative; reservations never exceed stock; value follows quantity.
ALTER TABLE "inventory_balances"
  ADD CONSTRAINT "ck_inventory_balances_non_negative" CHECK ("quantity" >= 0),
  ADD CONSTRAINT "ck_inventory_balances_reserved" CHECK ("reserved_quantity" >= 0 AND "reserved_quantity" <= "quantity"),
  ADD CONSTRAINT "ck_inventory_balances_value" CHECK ("value_base_amount" >= 0 AND ("quantity" > 0 OR "value_base_amount" = 0));

-- A movement always moves something, in the direction its type implies.
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "ck_inventory_movements_non_zero" CHECK ("quantity" <> 0),
  ADD CONSTRAINT "ck_inventory_movements_balance_after" CHECK ("balance_after" >= 0),
  ADD CONSTRAINT "ck_inventory_movements_sign" CHECK (
    ("type" IN ('OPENING', 'PURCHASE', 'RETURN', 'TRANSFER_IN') AND "quantity" > 0)
    OR ("type" IN ('SALE', 'TRANSFER_OUT', 'DAMAGE') AND "quantity" < 0)
    OR ("type" IN ('ADJUSTMENT', 'STOCKTAKE'))
  ),
  ADD CONSTRAINT "ck_inventory_movements_cost" CHECK (
    ("unit_cost_amount" IS NULL AND "unit_cost_currency" IS NULL AND "rate_to_base" IS NULL)
    OR ("unit_cost_amount" >= 0 AND "unit_cost_currency" IN ('SYP', 'USD') AND "rate_to_base" > 0)
  ),
  ADD CONSTRAINT "ck_inventory_movements_unit_cost_base" CHECK ("unit_cost_base_amount" >= 0);

ALTER TABLE "reservations"
  ADD CONSTRAINT "ck_reservations_quantity" CHECK ("quantity" > 0);

ALTER TABLE "scan_session_lines"
  ADD CONSTRAINT "ck_scan_session_lines_quantity" CHECK ("quantity" >= 0),
  ADD CONSTRAINT "ck_scan_session_lines_cost" CHECK (
    ("unit_cost_amount" IS NULL AND "unit_cost_currency" IS NULL AND "rate_to_base" IS NULL)
    OR ("unit_cost_amount" >= 0 AND "unit_cost_currency" IN ('SYP', 'USD') AND "rate_to_base" > 0)
  );

ALTER TABLE "scan_sessions"
  ADD CONSTRAINT "ck_scan_sessions_transfer_target" CHECK (
    ("kind" = 'TRANSFER' AND "to_location_id" IS NOT NULL AND "to_location_id" <> "location_id")
    OR ("kind" <> 'TRANSFER' AND "to_location_id" IS NULL)
  );

ALTER TABLE "stocktake_lines"
  ADD CONSTRAINT "ck_stocktake_lines_quantities" CHECK ("expected_quantity" >= 0 AND ("counted_quantity" IS NULL OR "counted_quantity" >= 0));

-- Internal barcodes are 13 digits (EAN-13). The check digit itself is validated in code.
ALTER TABLE "product_variants"
  ADD CONSTRAINT "ck_product_variants_barcode_format" CHECK ("barcode" ~ '^[0-9]{13}$');

-- Barcode allocation (ADR-003): 9-digit sequence inside the EAN-13 data portion.
CREATE SEQUENCE "variant_barcode_seq" AS BIGINT START WITH 1 MINVALUE 1 MAXVALUE 999999999 NO CYCLE;

-- Append-only tables. A trigger, not REVOKE: it holds whichever role connects.
CREATE FUNCTION "reject_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % rejected', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "trg_inventory_movements_append_only"
  BEFORE UPDATE OR DELETE ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();

CREATE TRIGGER "trg_audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
