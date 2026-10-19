-- ADR-013: the general ledger (double entry, USD base, append-only).
-- The default chart of accounts is installed by code (accounting/chart.ts) at start-up, not here,
-- so the test database gets it too after it is wiped.

-- The official rate is kept next to the owner's (market) rate, for reference only (ADR-013).
ALTER TABLE "exchange_rates"
  ADD COLUMN "official_rate" DECIMAL(18,6),
  ADD CONSTRAINT "ck_exchange_rates_official_rate" CHECK ("official_rate" IS NULL OR "official_rate" > 0);

-- ─── Chart of accounts ───────────────────────────────────────────────────────────────────────
CREATE TABLE "gl_accounts" (
  "id"          UUID         NOT NULL,
  "code"        TEXT         NOT NULL,
  "name_ar"     TEXT         NOT NULL,
  "class"       SMALLINT     NOT NULL,
  "parent_id"   UUID,
  "is_postable" BOOLEAN      NOT NULL DEFAULT true,
  "currency"    CHAR(3),
  "kind"        TEXT         NOT NULL DEFAULT 'GENERAL',
  "system_role" TEXT,
  "location_id" UUID,
  "branch"      CHAR(2),
  "is_active"   BOOLEAN      NOT NULL DEFAULT true,
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "gl_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_gl_accounts_code" ON "gl_accounts"("code");
CREATE UNIQUE INDEX "uq_gl_accounts_system_role" ON "gl_accounts"("system_role");
CREATE UNIQUE INDEX "uq_gl_accounts_location_id" ON "gl_accounts"("location_id");
CREATE INDEX "idx_gl_accounts_parent_id" ON "gl_accounts"("parent_id");
ALTER TABLE "gl_accounts"
  ADD CONSTRAINT "gl_accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "gl_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "gl_accounts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_gl_accounts_class" CHECK ("class" BETWEEN 1 AND 5),
  ADD CONSTRAINT "ck_gl_accounts_currency" CHECK ("currency" IS NULL OR "currency" IN ('SYP', 'USD', 'LYD')),
  ADD CONSTRAINT "ck_gl_accounts_kind" CHECK ("kind" IN ('GENERAL', 'CASH', 'INVENTORY')),
  ADD CONSTRAINT "ck_gl_accounts_cash_currency" CHECK ("kind" <> 'CASH' OR "currency" IS NOT NULL),
  ADD CONSTRAINT "ck_gl_accounts_branch" CHECK ("branch" IS NULL OR "branch" IN ('SY', 'LY'));

-- ─── Journal ─────────────────────────────────────────────────────────────────────────────────
-- One entry (قيد) per voucher or per stock movement; its lines balance in USD cents.
CREATE TABLE "journal_entries" (
  "id"           UUID         NOT NULL,
  "voucher_type" TEXT         NOT NULL,
  "voucher_year" SMALLINT     NOT NULL,
  "voucher_no"   INTEGER      NOT NULL,
  "entry_date"   DATE         NOT NULL,
  "memo"         TEXT,
  "source_type"  TEXT,
  "source_id"    TEXT,
  "reverses_id"  UUID,
  "created_by"   UUID         NOT NULL,
  "created_at"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_journal_entries_voucher" ON "journal_entries"("voucher_type", "voucher_year", "voucher_no");
-- Posting is idempotent: one entry per source document, ever.
CREATE UNIQUE INDEX "uq_journal_entries_source" ON "journal_entries"("source_type", "source_id");
-- An entry is reversed at most once.
CREATE UNIQUE INDEX "uq_journal_entries_reverses_id" ON "journal_entries"("reverses_id");
CREATE INDEX "idx_journal_entries_entry_date" ON "journal_entries"("entry_date");
ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "journal_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_journal_entries_voucher_type" CHECK ("voucher_type" IN ('RECEIPT', 'PAYMENT', 'TRANSFER', 'EXCHANGE', 'JOURNAL', 'INVENTORY', 'REVALUATION', 'REVERSAL')),
  ADD CONSTRAINT "ck_journal_entries_voucher_no" CHECK ("voucher_no" > 0),
  ADD CONSTRAINT "ck_journal_entries_source" CHECK (("source_type" IS NULL) = ("source_id" IS NULL));

-- amount_base: USD cents, debit positive. amount_currency: the same amount in the line's own
-- currency (minor units, same sign). rate: units of that currency per 1 USD.
CREATE TABLE "journal_lines" (
  "id"              UUID          NOT NULL,
  "entry_id"        UUID          NOT NULL,
  "line_no"         SMALLINT      NOT NULL,
  "account_id"      UUID          NOT NULL,
  "amount_base"     BIGINT        NOT NULL,
  "currency"        CHAR(3)       NOT NULL,
  "amount_currency" BIGINT        NOT NULL,
  "rate"            DECIMAL(18,6) NOT NULL,
  "branch"          CHAR(2),
  "location_id"     UUID,
  "memo"            TEXT,
  CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_journal_lines_entry_line" ON "journal_lines"("entry_id", "line_no");
CREATE INDEX "idx_journal_lines_account_id" ON "journal_lines"("account_id");
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "journal_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "gl_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "journal_lines_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_journal_lines_currency" CHECK ("currency" IN ('SYP', 'USD', 'LYD')),
  ADD CONSTRAINT "ck_journal_lines_rate" CHECK ("rate" > 0),
  ADD CONSTRAINT "ck_journal_lines_branch" CHECK ("branch" IS NULL OR "branch" IN ('SY', 'LY')),
  ADD CONSTRAINT "ck_journal_lines_non_zero" CHECK ("amount_base" <> 0 OR "amount_currency" <> 0),
  ADD CONSTRAINT "ck_journal_lines_sign" CHECK ("amount_base" = 0 OR "amount_currency" = 0 OR sign("amount_base") = sign("amount_currency")),
  ADD CONSTRAINT "ck_journal_lines_usd" CHECK ("currency" <> 'USD' OR ("amount_currency" = "amount_base" AND "rate" = 1));

-- ─── Closed months, voucher numbers, posting cursor ──────────────────────────────────────────
CREATE TABLE "accounting_periods" (
  "period"               CHAR(7)      NOT NULL,
  "ends_on"              DATE         NOT NULL,
  "revaluation_entry_id" UUID,
  "closed_by"            UUID         NOT NULL,
  "closed_at"            TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("period")
);
ALTER TABLE "accounting_periods"
  ADD CONSTRAINT "accounting_periods_revaluation_entry_id_fkey" FOREIGN KEY ("revaluation_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "accounting_periods_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_accounting_periods_period" CHECK ("period" ~ '^[0-9]{4}-[0-9]{2}$');

-- Gap-free voucher numbers per type and year: the row is locked while a number is taken.
CREATE TABLE "voucher_counters" (
  "voucher_type" TEXT     NOT NULL,
  "voucher_year" SMALLINT NOT NULL,
  "last_no"      INTEGER  NOT NULL,
  CONSTRAINT "voucher_counters_pkey" PRIMARY KEY ("voucher_type", "voucher_year")
);

-- How far the stock ledger has been posted for certain (see accounting/inventory-posting.ts).
CREATE TABLE "accounting_sync_state" (
  "name"     TEXT   NOT NULL,
  "last_seq" BIGINT NOT NULL,
  CONSTRAINT "accounting_sync_state_pkey" PRIMARY KEY ("name")
);

-- ─── Rules the database itself enforces ──────────────────────────────────────────────────────
-- Nothing posted is ever changed or removed: a mistake is corrected by a reversing entry.
CREATE TRIGGER "trg_journal_entries_append_only"
  BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "trg_journal_lines_append_only"
  BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "trg_accounting_periods_append_only"
  BEFORE UPDATE OR DELETE ON "accounting_periods"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();

-- Debits equal credits, checked at commit (deferred), once every line is in.
CREATE FUNCTION "assert_journal_entry_balanced"(entry UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  total BIGINT;
  lines INTEGER;
BEGIN
  SELECT coalesce(sum("amount_base"), 0), count(*) INTO total, lines
    FROM "journal_lines" WHERE "entry_id" = entry;
  IF lines < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'journal entry % is not balanced (% lines, total % cents)', entry, lines, total
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;
CREATE FUNCTION "check_journal_entry_balanced"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "assert_journal_entry_balanced"(NEW."id");
  RETURN NULL;
END;
$$;
CREATE FUNCTION "check_journal_line_balanced"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "assert_journal_entry_balanced"(NEW."entry_id");
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "trg_journal_entries_balanced"
  AFTER INSERT ON "journal_entries" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_journal_entry_balanced"();
CREATE CONSTRAINT TRIGGER "trg_journal_lines_balanced"
  AFTER INSERT ON "journal_lines" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_journal_line_balanced"();

-- A line goes to a postable account, in that account's currency when it has one.
CREATE FUNCTION "check_journal_line_account"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acc RECORD;
BEGIN
  SELECT "is_postable", "currency" INTO acc FROM "gl_accounts" WHERE "id" = NEW."account_id";
  IF NOT acc."is_postable" THEN
    RAISE EXCEPTION 'account % is a heading and takes no postings', NEW."account_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF acc."currency" IS NOT NULL AND acc."currency" <> NEW."currency" THEN
    RAISE EXCEPTION 'account % holds %, not %', NEW."account_id", acc."currency", NEW."currency"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_journal_lines_account"
  BEFORE INSERT ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION "check_journal_line_account"();

-- No entry is dated inside a closed month (Syrian Commercial Law 33/2007 art. 17: no changes).
CREATE FUNCTION "check_journal_entry_period"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "accounting_periods" WHERE "ends_on" >= NEW."entry_date") THEN
    RAISE EXCEPTION 'the period containing % is closed', NEW."entry_date"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "trg_journal_entries_period"
  BEFORE INSERT ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "check_journal_entry_period"();
