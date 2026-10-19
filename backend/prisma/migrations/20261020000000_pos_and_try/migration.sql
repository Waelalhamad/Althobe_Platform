-- ADR-014: the store's point of sale, and the Turkish lira (TRY) as a fourth currency.
-- TRY is money the business holds and is paid in (the store drawer) and may buy in; selling
-- prices stay SYP, LYD and USD (ADR-012).

-- ─── TRY wherever money is held, costed or posted ────────────────────────────────────────────
ALTER TABLE "exchange_rates" DROP CONSTRAINT "ck_exchange_rates_currency",
  ADD CONSTRAINT "ck_exchange_rates_currency" CHECK ("currency" IN ('SYP', 'LYD', 'TRY'));

ALTER TABLE "inventory_movements" DROP CONSTRAINT "ck_inventory_movements_cost",
  ADD CONSTRAINT "ck_inventory_movements_cost" CHECK (
    ("unit_cost_amount" IS NULL AND "unit_cost_currency" IS NULL AND "rate_to_base" IS NULL)
    OR ("unit_cost_amount" >= 0 AND "unit_cost_currency" IN ('SYP', 'USD', 'LYD', 'TRY') AND "rate_to_base" > 0)
  );
ALTER TABLE "scan_session_lines" DROP CONSTRAINT "ck_scan_session_lines_cost",
  ADD CONSTRAINT "ck_scan_session_lines_cost" CHECK (
    ("unit_cost_amount" IS NULL AND "unit_cost_currency" IS NULL AND "rate_to_base" IS NULL)
    OR ("unit_cost_amount" >= 0 AND "unit_cost_currency" IN ('SYP', 'USD', 'LYD', 'TRY') AND "rate_to_base" > 0)
  );

ALTER TABLE "gl_accounts" DROP CONSTRAINT "ck_gl_accounts_currency",
  ADD CONSTRAINT "ck_gl_accounts_currency" CHECK ("currency" IS NULL OR "currency" IN ('SYP', 'USD', 'LYD', 'TRY'));
ALTER TABLE "journal_lines" DROP CONSTRAINT "ck_journal_lines_currency",
  ADD CONSTRAINT "ck_journal_lines_currency" CHECK ("currency" IN ('SYP', 'USD', 'LYD', 'TRY'));

-- A closed shift posts one RETAIL entry (sales, cash per currency, over/short).
ALTER TABLE "journal_entries" DROP CONSTRAINT "ck_journal_entries_voucher_type",
  ADD CONSTRAINT "ck_journal_entries_voucher_type" CHECK ("voucher_type" IN ('RECEIPT', 'PAYMENT', 'TRANSFER', 'EXCHANGE', 'JOURNAL', 'INVENTORY', 'REVALUATION', 'REVERSAL', 'RETAIL'));

-- ─── Shifts (الورديات) ──────────────────────────────────────────────────────────────────────
-- One drawer per store: at most one open shift per location.
CREATE TABLE "pos_shifts" (
  "id"               UUID         NOT NULL,
  "location_id"      UUID         NOT NULL,
  "status"           TEXT         NOT NULL DEFAULT 'OPEN',
  "opened_by"        UUID         NOT NULL,
  "opened_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_by"        UUID,
  "closed_at"        TIMESTAMPTZ(3),
  "journal_entry_id" UUID,
  CONSTRAINT "pos_shifts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_pos_shifts_open_per_location" ON "pos_shifts"("location_id") WHERE "status" = 'OPEN';
CREATE INDEX "idx_pos_shifts_location_opened" ON "pos_shifts"("location_id", "opened_at" DESC);
ALTER TABLE "pos_shifts"
  ADD CONSTRAINT "pos_shifts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_shifts_opened_by_fkey" FOREIGN KEY ("opened_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_shifts_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_shifts_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_pos_shifts_status" CHECK ("status" IN ('OPEN', 'CLOSED')),
  ADD CONSTRAINT "ck_pos_shifts_closed" CHECK (("status" = 'OPEN') = ("closed_at" IS NULL));

-- The drawer per currency: what it held at opening, and what was counted at closing.
CREATE TABLE "pos_shift_cash" (
  "shift_id" UUID    NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "opening"  BIGINT  NOT NULL,
  "counted"  BIGINT,
  CONSTRAINT "pos_shift_cash_pkey" PRIMARY KEY ("shift_id", "currency")
);
ALTER TABLE "pos_shift_cash"
  ADD CONSTRAINT "pos_shift_cash_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "pos_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_pos_shift_cash_currency" CHECK ("currency" IN ('SYP', 'USD', 'TRY')),
  ADD CONSTRAINT "ck_pos_shift_cash_amounts" CHECK ("opening" >= 0 AND ("counted" IS NULL OR "counted" >= 0));

-- ─── Sales and refunds (فواتير البيع والمرتجعات) ───────────────────────────────────────────
-- Amounts in SYP minor units (the store's currency); positive for a sale and for a refund alike.
CREATE TABLE "pos_sales" (
  "id"            UUID         NOT NULL,
  "kind"          TEXT         NOT NULL,
  "receipt_year"  SMALLINT     NOT NULL,
  "receipt_no"    INTEGER      NOT NULL,
  "shift_id"      UUID         NOT NULL,
  "location_id"   UUID         NOT NULL,
  "refund_of_id"  UUID,
  "subtotal"      BIGINT       NOT NULL,
  "discount"      BIGINT       NOT NULL DEFAULT 0,
  "total"         BIGINT       NOT NULL,
  -- The total in USD cents at the SYP rate of the moment (ADR-013 base).
  "total_base"    BIGINT       NOT NULL,
  -- Change given back, always SYP.
  "change"        BIGINT       NOT NULL DEFAULT 0,
  "syp_rate"      DECIMAL(18,6) NOT NULL,
  "note"          TEXT,
  "created_by"    UUID         NOT NULL,
  "created_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pos_sales_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_pos_sales_receipt" ON "pos_sales"("kind", "receipt_year", "receipt_no");
CREATE INDEX "idx_pos_sales_shift_id" ON "pos_sales"("shift_id");
CREATE INDEX "idx_pos_sales_refund_of_id" ON "pos_sales"("refund_of_id");
ALTER TABLE "pos_sales"
  ADD CONSTRAINT "pos_sales_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "pos_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_sales_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_sales_refund_of_id_fkey" FOREIGN KEY ("refund_of_id") REFERENCES "pos_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_sales_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_pos_sales_kind" CHECK ("kind" IN ('SALE', 'REFUND')),
  ADD CONSTRAINT "ck_pos_sales_refund_of" CHECK (("kind" = 'REFUND') = ("refund_of_id" IS NOT NULL)),
  ADD CONSTRAINT "ck_pos_sales_amounts" CHECK (
    "subtotal" > 0 AND "discount" >= 0 AND "discount" < "subtotal"
    AND "total" = "subtotal" - "discount" AND "change" >= 0 AND "syp_rate" > 0
  );

CREATE TABLE "pos_sale_lines" (
  "sale_id"        UUID    NOT NULL,
  "line_no"        SMALLINT NOT NULL,
  "variant_id"     UUID    NOT NULL,
  "quantity"       INTEGER NOT NULL,
  "unit_price"     BIGINT  NOT NULL,
  -- After its share of the discount: what this line was really sold (or refunded) for.
  "net_total"      BIGINT  NOT NULL,
  -- The refunded line of the original sale.
  "refund_of_line" SMALLINT,
  -- What one piece cost, USD cents, as the stock ledger valued it when it left (or came back).
  "unit_cost_base" BIGINT NOT NULL,
  CONSTRAINT "pos_sale_lines_pkey" PRIMARY KEY ("sale_id", "line_no")
);
CREATE INDEX "idx_pos_sale_lines_variant_id" ON "pos_sale_lines"("variant_id");
ALTER TABLE "pos_sale_lines"
  ADD CONSTRAINT "pos_sale_lines_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "pos_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "pos_sale_lines_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_pos_sale_lines_amounts" CHECK ("quantity" > 0 AND "unit_price" > 0 AND "net_total" >= 0);

-- What was handed over, per currency (a refund pays back SYP: a negative amount).
CREATE TABLE "pos_payments" (
  "sale_id"   UUID          NOT NULL,
  "currency"  CHAR(3)       NOT NULL,
  "amount"    BIGINT        NOT NULL,
  -- Units of the currency per 1 USD at the time (1 for USD).
  "rate"      DECIMAL(18,6) NOT NULL,
  "base"      BIGINT        NOT NULL,
  CONSTRAINT "pos_payments_pkey" PRIMARY KEY ("sale_id", "currency")
);
ALTER TABLE "pos_payments"
  ADD CONSTRAINT "pos_payments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "pos_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_pos_payments_currency" CHECK ("currency" IN ('SYP', 'USD', 'TRY')),
  ADD CONSTRAINT "ck_pos_payments_amount" CHECK ("amount" <> 0 AND "rate" > 0);

-- Gap-free receipt numbers per kind and year.
CREATE TABLE "pos_counters" (
  "kind"    TEXT     NOT NULL,
  "year"    SMALLINT NOT NULL,
  "last_no" INTEGER  NOT NULL,
  CONSTRAINT "pos_counters_pkey" PRIMARY KEY ("kind", "year")
);

-- A receipt is a legal record: once issued it never changes. A refund is a new receipt.
CREATE TRIGGER "trg_pos_sales_append_only"
  BEFORE UPDATE OR DELETE ON "pos_sales"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "trg_pos_sale_lines_append_only"
  BEFORE UPDATE OR DELETE ON "pos_sale_lines"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "trg_pos_payments_append_only"
  BEFORE UPDATE OR DELETE ON "pos_payments"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
