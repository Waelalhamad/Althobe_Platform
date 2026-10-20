-- ADR-015: employees, their advances (السلف) and pay sheets (كشوف الرواتب).
-- The payroll tables are the detail; the books hold the totals: 1104 سلف الموظفين,
-- 2102 رواتب مستحقة, 5202 الرواتب والأجور. Only the payroll module posts to the first two.

-- An approved pay sheet posts one PAYROLL entry (the month's salary expense).
ALTER TABLE "journal_entries" DROP CONSTRAINT "ck_journal_entries_voucher_type",
  ADD CONSTRAINT "ck_journal_entries_voucher_type" CHECK ("voucher_type" IN ('RECEIPT', 'PAYMENT', 'TRANSFER', 'EXCHANGE', 'JOURNAL', 'INVENTORY', 'REVALUATION', 'REVERSAL', 'RETAIL', 'PAYROLL'));

-- ─── Employees (الموظفون) ──────────────────────────────────────────────────────────────────
CREATE TABLE "employees" (
  "id"         UUID         NOT NULL,
  "name_ar"    TEXT         NOT NULL,
  "phone"      TEXT,
  "job_title"  TEXT,
  "branch"     CHAR(2)      NOT NULL DEFAULT 'SY',
  -- The salary's currency; advances and pay are in it too.
  "currency"   CHAR(3)      NOT NULL,
  -- Per pay period (a month or a week), minor units of the currency.
  "salary"     BIGINT       NOT NULL,
  "frequency"  TEXT         NOT NULL DEFAULT 'MONTHLY',
  "notes"      TEXT,
  "is_active"  BOOLEAN      NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "employees"
  ADD CONSTRAINT "ck_employees_branch" CHECK ("branch" IN ('SY', 'LY')),
  ADD CONSTRAINT "ck_employees_currency" CHECK ("currency" IN ('SYP', 'USD', 'LYD', 'TRY')),
  ADD CONSTRAINT "ck_employees_salary" CHECK ("salary" >= 0),
  ADD CONSTRAINT "ck_employees_frequency" CHECK ("frequency" IN ('MONTHLY', 'WEEKLY'));

-- ─── Pay sheets (كشوف الرواتب) ─────────────────────────────────────────────────────────────
-- One sheet per frequency and period. A cancelled sheet frees its period for a new one.
CREATE TABLE "payroll_runs" (
  "id"                UUID         NOT NULL,
  "frequency"         TEXT         NOT NULL,
  "period_start"      DATE         NOT NULL,
  "period_end"        DATE         NOT NULL,
  "status"            TEXT         NOT NULL DEFAULT 'DRAFT',
  "accrual_entry_id"  UUID,
  "reversal_entry_id" UUID,
  "created_by"        UUID         NOT NULL,
  "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approved_by"       UUID,
  "approved_at"       TIMESTAMPTZ(3),
  "cancelled_at"      TIMESTAMPTZ(3),
  CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_payroll_runs_period" ON "payroll_runs"("frequency", "period_start") WHERE "status" <> 'CANCELLED';
CREATE INDEX "idx_payroll_runs_period_start" ON "payroll_runs"("period_start" DESC);
ALTER TABLE "payroll_runs"
  ADD CONSTRAINT "payroll_runs_accrual_entry_id_fkey" FOREIGN KEY ("accrual_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "payroll_runs_reversal_entry_id_fkey" FOREIGN KEY ("reversal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "payroll_runs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "payroll_runs_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_payroll_runs_frequency" CHECK ("frequency" IN ('MONTHLY', 'WEEKLY')),
  ADD CONSTRAINT "ck_payroll_runs_status" CHECK ("status" IN ('DRAFT', 'APPROVED', 'CANCELLED')),
  ADD CONSTRAINT "ck_payroll_runs_period" CHECK ("period_end" >= "period_start");

-- What was paid out of a box for a sheet: one entry, one or more employees.
CREATE TABLE "payroll_payments" (
  "id"               UUID         NOT NULL,
  "run_id"           UUID         NOT NULL,
  "box_account_id"   UUID         NOT NULL,
  "currency"         CHAR(3)      NOT NULL,
  "amount"           BIGINT       NOT NULL,
  "journal_entry_id" UUID,
  "paid_by"          UUID         NOT NULL,
  "paid_at"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payroll_payments_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "payroll_payments"
  ADD CONSTRAINT "payroll_payments_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "payroll_payments_box_account_id_fkey" FOREIGN KEY ("box_account_id") REFERENCES "gl_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "payroll_payments_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "payroll_payments_paid_by_fkey" FOREIGN KEY ("paid_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_payroll_payments_amount" CHECK ("amount" >= 0);

-- One employee on one sheet. Editable while the sheet is a draft; fixed once approved.
CREATE TABLE "payroll_lines" (
  "id"             UUID    NOT NULL,
  "run_id"         UUID    NOT NULL,
  "employee_id"    UUID    NOT NULL,
  "currency"       CHAR(3) NOT NULL,
  "branch"         CHAR(2) NOT NULL,
  "salary"         BIGINT  NOT NULL,
  "bonus"          BIGINT  NOT NULL DEFAULT 0,
  "deduction"      BIGINT  NOT NULL DEFAULT 0,
  "deduction_note" TEXT,
  -- Taken back from the employee's advances on this sheet.
  "advance_deduct" BIGINT  NOT NULL DEFAULT 0,
  -- USD cents of the net pay owed (2102), fixed at approval; a payment clears exactly this.
  "net_base"       BIGINT,
  "payment_id"     UUID,
  CONSTRAINT "payroll_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_payroll_lines_run_employee" ON "payroll_lines"("run_id", "employee_id");
CREATE INDEX "idx_payroll_lines_employee_id" ON "payroll_lines"("employee_id");
ALTER TABLE "payroll_lines"
  ADD CONSTRAINT "payroll_lines_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "payroll_lines_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "payroll_lines_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payroll_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_payroll_lines_amounts" CHECK (
    "salary" >= 0 AND "bonus" >= 0 AND "deduction" >= 0 AND "advance_deduct" >= 0
    AND "salary" + "bonus" - "deduction" - "advance_deduct" >= 0
  );

-- ─── Advances (السلف) ──────────────────────────────────────────────────────────────────────
-- Every change to what an employee owes: GIVEN and RESTORED add, REPAID and DEDUCTED take away.
-- amount_base is the USD value it carries in 1104, so the books and this table always agree.
CREATE TABLE "employee_advances" (
  "id"               UUID         NOT NULL,
  "employee_id"      UUID         NOT NULL,
  "kind"             TEXT         NOT NULL,
  "amount"           BIGINT       NOT NULL,
  "amount_base"      BIGINT       NOT NULL,
  "journal_entry_id" UUID,
  "payroll_line_id"  UUID,
  "note"             TEXT,
  "created_by"       UUID         NOT NULL,
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "employee_advances_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "idx_employee_advances_employee" ON "employee_advances"("employee_id", "created_at");
ALTER TABLE "employee_advances"
  ADD CONSTRAINT "employee_advances_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "employee_advances_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "employee_advances_payroll_line_id_fkey" FOREIGN KEY ("payroll_line_id") REFERENCES "payroll_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "employee_advances_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_employee_advances_kind" CHECK ("kind" IN ('GIVEN', 'REPAID', 'DEDUCTED', 'RESTORED')),
  ADD CONSTRAINT "ck_employee_advances_amount" CHECK ("amount" > 0 AND "amount_base" >= 0),
  ADD CONSTRAINT "ck_employee_advances_line" CHECK (("kind" IN ('DEDUCTED', 'RESTORED')) = ("payroll_line_id" IS NOT NULL));

-- Money records: what happened stays as it happened.
CREATE TRIGGER "trg_employee_advances_append_only"
  BEFORE UPDATE OR DELETE ON "employee_advances"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
CREATE TRIGGER "trg_payroll_payments_append_only"
  BEFORE UPDATE OR DELETE ON "payroll_payments"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
