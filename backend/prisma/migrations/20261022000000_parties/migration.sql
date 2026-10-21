-- ADR-016: suppliers and customers (الموردون والزبائن) — who owes us, and whom we owe.
-- The parties tables are the detail; the books hold the totals: 1103 الزبائن, 2101 الموردون.
-- Only the parties module posts to them from now on.

-- A sale or a credit note on account (wholesale, the store's على الحساب) is an INVOICE entry.
ALTER TABLE "journal_entries" DROP CONSTRAINT "ck_journal_entries_voucher_type",
  ADD CONSTRAINT "ck_journal_entries_voucher_type" CHECK ("voucher_type" IN ('RECEIPT', 'PAYMENT', 'TRANSFER', 'EXCHANGE', 'JOURNAL', 'INVENTORY', 'REVALUATION', 'REVERSAL', 'RETAIL', 'PAYROLL', 'INVOICE'));

-- ─── Parties ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE "parties" (
  "id"         UUID         NOT NULL,
  -- SUPPLIER: we owe them for goods. CUSTOMER: they owe us (on account at the store, wholesale).
  "kind"       TEXT         NOT NULL,
  "name_ar"    TEXT         NOT NULL,
  "phone"      TEXT,
  "currency"   CHAR(3)      NOT NULL,
  "branch"     CHAR(2)      NOT NULL DEFAULT 'SY',
  "notes"      TEXT,
  "is_active"  BOOLEAN      NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "parties_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "idx_parties_kind_name" ON "parties"("kind", "name_ar");
ALTER TABLE "parties"
  ADD CONSTRAINT "ck_parties_kind" CHECK ("kind" IN ('SUPPLIER', 'CUSTOMER')),
  ADD CONSTRAINT "ck_parties_currency" CHECK ("currency" IN ('SYP', 'USD', 'LYD', 'TRY')),
  ADD CONSTRAINT "ck_parties_branch" CHECK ("branch" IN ('SY', 'LY'));

-- Every change to what is outstanding with a party. amount > 0 makes more outstanding (a bill
-- we owe, an invoice they owe); amount < 0 settles it. amount_base is the USD value it carries
-- in 1103 or 2101, so the books and this table always agree.
CREATE TABLE "party_entries" (
  "id"               UUID         NOT NULL,
  "party_id"         UUID         NOT NULL,
  -- BILL · PAYMENT (suppliers) · INVOICE · RECEIPT · POS_SALE · POS_REFUND (customers)
  "kind"             TEXT         NOT NULL,
  "amount"           BIGINT       NOT NULL,
  "amount_base"      BIGINT       NOT NULL,
  -- What it came from: a scan session (receipt, goods out), a POS sale, or itself (a payment).
  "source_type"      TEXT         NOT NULL,
  "source_id"        UUID         NOT NULL,
  "journal_entry_id" UUID,
  "note"             TEXT,
  "created_by"       UUID         NOT NULL,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "party_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "idx_party_entries_party" ON "party_entries"("party_id", "created_at");
-- One row of a kind per source: a retried request never records twice.
CREATE UNIQUE INDEX "uq_party_entries_source" ON "party_entries"("kind", "source_id");
ALTER TABLE "party_entries"
  ADD CONSTRAINT "party_entries_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "party_entries_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "party_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_party_entries_kind" CHECK ("kind" IN ('BILL', 'PAYMENT', 'INVOICE', 'RECEIPT', 'POS_SALE', 'POS_REFUND')),
  ADD CONSTRAINT "ck_party_entries_amount" CHECK ("amount" <> 0);

CREATE TRIGGER "trg_party_entries_append_only"
  BEFORE UPDATE OR DELETE ON "party_entries"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();

-- ─── A store sale on account (على الحساب) ──────────────────────────────────────────────────
-- Part (or all) of the total that the customer owes instead of paying, SYP minor units, and its
-- USD value. On a refund: what went back onto the account instead of out of the drawer.
ALTER TABLE "pos_sales"
  ADD COLUMN "party_id"        UUID,
  ADD COLUMN "on_account"      BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "on_account_base" BIGINT NOT NULL DEFAULT 0,
  ADD CONSTRAINT "pos_sales_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_pos_sales_on_account" CHECK ("on_account" >= 0 AND "on_account" <= "total" AND (("on_account" = 0) OR ("party_id" IS NOT NULL)));
