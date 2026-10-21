-- Developer report F-05: every exchange rate the owner sets, from when it applied. Postings
-- keep the rate they used on their own lines (ADR-013); this lets closing a month revalue at the
-- rate that applied on its last day, and shows who changed a rate, from what, and when.
CREATE TABLE "exchange_rate_history" (
  "id"            UUID          NOT NULL,
  "currency"      CHAR(3)       NOT NULL,
  "rate"          DECIMAL(18,6) NOT NULL,
  "official_rate" DECIMAL(18,6),
  "set_by"        UUID          NOT NULL,
  "set_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "exchange_rate_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "idx_exchange_rate_history_currency_set_at" ON "exchange_rate_history"("currency", "set_at" DESC);
ALTER TABLE "exchange_rate_history"
  ADD CONSTRAINT "exchange_rate_history_set_by_fkey" FOREIGN KEY ("set_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ck_exchange_rate_history_currency" CHECK ("currency" IN ('SYP', 'LYD', 'TRY')),
  ADD CONSTRAINT "ck_exchange_rate_history_rate" CHECK ("rate" > 0);

CREATE TRIGGER "trg_exchange_rate_history_append_only"
  BEFORE UPDATE OR DELETE ON "exchange_rate_history"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();

-- The rates already set count from when they were last changed.
INSERT INTO "exchange_rate_history" ("id", "currency", "rate", "official_rate", "set_by", "set_at")
SELECT gen_random_uuid(), "currency", "rate", "official_rate", "updated_by", "updated_at"
FROM "exchange_rates";
