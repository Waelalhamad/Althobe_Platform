-- ADR-012: retail prices in SYP (Syria) and LYD (Libya), wholesale in USD; stock is valued in
-- USD; the owner keeps the exchange rates. Owner decisions of 2026-10-13: the old USD retail
-- prices are cleared, wholesale stays USD, the rates are typed in after the release.

-- ── 1. The Libyan dinar joins the currencies (3 decimals, ISO 4217) ─────────────────────────

ALTER TABLE "product_prices" DROP CONSTRAINT "ck_product_prices_currency",
  ADD CONSTRAINT "ck_product_prices_currency" CHECK ("currency" IN ('SYP', 'USD', 'LYD'));
ALTER TABLE "variant_prices" DROP CONSTRAINT "ck_variant_prices_currency",
  ADD CONSTRAINT "ck_variant_prices_currency" CHECK ("currency" IN ('SYP', 'USD', 'LYD'));

ALTER TABLE "inventory_movements" DROP CONSTRAINT "ck_inventory_movements_cost",
  ADD CONSTRAINT "ck_inventory_movements_cost" CHECK (
    ("unit_cost_amount" IS NULL AND "unit_cost_currency" IS NULL AND "rate_to_base" IS NULL)
    OR ("unit_cost_amount" >= 0 AND "unit_cost_currency" IN ('SYP', 'USD', 'LYD') AND "rate_to_base" > 0)
  );
ALTER TABLE "scan_session_lines" DROP CONSTRAINT "ck_scan_session_lines_cost",
  ADD CONSTRAINT "ck_scan_session_lines_cost" CHECK (
    ("unit_cost_amount" IS NULL AND "unit_cost_currency" IS NULL AND "rate_to_base" IS NULL)
    OR ("unit_cost_amount" >= 0 AND "unit_cost_currency" IN ('SYP', 'USD', 'LYD') AND "rate_to_base" > 0)
  );

-- ── 2. Price lists: retail per country, each list in one currency ───────────────────────────

DELETE FROM "product_prices" WHERE "list" = 'RETAIL';
DELETE FROM "variant_prices" WHERE "list" = 'RETAIL';

ALTER TYPE "price_list" RENAME TO "price_list_old";
CREATE TYPE "price_list" AS ENUM ('RETAIL_SYP', 'RETAIL_LYD', 'WHOLESALE');
ALTER TABLE "product_prices" ALTER COLUMN "list" TYPE "price_list" USING "list"::text::"price_list";
ALTER TABLE "variant_prices" ALTER COLUMN "list" TYPE "price_list" USING "list"::text::"price_list";
DROP TYPE "price_list_old";

ALTER TABLE "product_prices" ADD CONSTRAINT "ck_product_prices_list_currency" CHECK (
  ("list" = 'RETAIL_SYP' AND "currency" = 'SYP')
  OR ("list" = 'RETAIL_LYD' AND "currency" = 'LYD')
  OR ("list" = 'WHOLESALE' AND "currency" = 'USD')
);
ALTER TABLE "variant_prices" ADD CONSTRAINT "ck_variant_prices_list_currency" CHECK (
  ("list" = 'RETAIL_SYP' AND "currency" = 'SYP')
  OR ("list" = 'RETAIL_LYD' AND "currency" = 'LYD')
  OR ("list" = 'WHOLESALE' AND "currency" = 'USD')
);

-- ── 3. Exchange rates: units of the currency per 1 USD, set by the owner ────────────────────

CREATE TABLE "exchange_rates" (
    "currency" CHAR(3) NOT NULL,
    "rate" DECIMAL(18,6) NOT NULL,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("currency")
);
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "exchange_rates"
  ADD CONSTRAINT "ck_exchange_rates_currency" CHECK ("currency" IN ('SYP', 'LYD')),
  ADD CONSTRAINT "ck_exchange_rates_rate" CHECK ("rate" > 0);

-- ── 4. Base currency SYP → USD ──────────────────────────────────────────────────────────────
-- rate_to_base now means "units of the cost's currency per 1 USD" (1 for USD). Until now it was
-- "SYP per 1 unit" (14000 for USD, 1 for SYP). Every stored value is recomputed by replaying the
-- ledger in order with the same rules as inventory.ledger.ts, so the USD values are exactly
-- what the new code would have written. SYP costs (none on the live database) use the rate of
-- the latest USD cost; with SYP costs and no USD cost there is no rate, and the release stops.

DO $$
DECLARE
  syp_rate numeric(18,6);
  m record;
  b_qty int;
  b_val bigint;
  need int;
  v bigint;
  u bigint;
  r numeric(18,6);
  paired bigint;
BEGIN
  SELECT "rate_to_base" INTO syp_rate FROM (
    SELECT "rate_to_base", "created_at" FROM "inventory_movements" WHERE "unit_cost_currency" = 'USD'
    UNION ALL
    SELECT "rate_to_base", "updated_at" FROM "scan_session_lines" WHERE "unit_cost_currency" = 'USD'
  ) usd ORDER BY "created_at" DESC LIMIT 1;

  IF syp_rate IS NULL AND (
    EXISTS (SELECT 1 FROM "inventory_movements" WHERE "unit_cost_currency" = 'SYP')
    OR EXISTS (SELECT 1 FROM "scan_session_lines" WHERE "unit_cost_currency" = 'SYP')
  ) THEN
    RAISE EXCEPTION 'SYP costs exist but no USD cost gives the rate to convert them';
  END IF;

  UPDATE "scan_session_lines" SET "rate_to_base" = CASE "unit_cost_currency" WHEN 'USD' THEN 1 ELSE syp_rate END
  WHERE "unit_cost_currency" IS NOT NULL;

  CREATE TEMP TABLE "_bal" (
    "variant_id" uuid, "location_id" uuid, "qty" int NOT NULL, "val" bigint NOT NULL,
    PRIMARY KEY ("variant_id", "location_id")
  ) ON COMMIT DROP;
  CREATE TEMP TABLE "_out" (
    "seq" bigint PRIMARY KEY, "transfer_id" uuid, "variant_id" uuid, "quantity" int, "value" bigint
  ) ON COMMIT DROP;

  ALTER TABLE "inventory_movements" DISABLE TRIGGER "trg_inventory_movements_append_only";

  FOR m IN SELECT * FROM "inventory_movements" ORDER BY "seq" LOOP
    SELECT "qty", "val" INTO b_qty, b_val FROM "_bal"
      WHERE "variant_id" = m."variant_id" AND "location_id" = m."location_id";
    IF NOT FOUND THEN b_qty := 0; b_val := 0; END IF;
    r := NULL;

    IF m."quantity" < 0 THEN
      need := -m."quantity";
      v := CASE WHEN need = b_qty THEN -b_val ELSE -round(b_val::numeric * need / b_qty) END;
      u := round((-v)::numeric / need);
      IF m."transfer_id" IS NOT NULL THEN
        INSERT INTO "_out" VALUES (m."seq", m."transfer_id", m."variant_id", m."quantity", v);
      END IF;
    ELSIF m."type" = 'TRANSFER_IN' THEN
      SELECT "value" INTO paired FROM "_out"
        WHERE "transfer_id" = m."transfer_id" AND "variant_id" = m."variant_id"
          AND "quantity" = -m."quantity" AND "seq" < m."seq"
        ORDER BY "seq" DESC LIMIT 1;
      v := -paired;
      u := round(v::numeric / m."quantity");
    ELSIF m."unit_cost_amount" IS NOT NULL THEN
      r := CASE m."unit_cost_currency" WHEN 'USD' THEN 1 ELSE syp_rate END;
      -- Minor units of the cost's currency → USD cents (SYP and USD have 2 decimals).
      u := round(m."unit_cost_amount"::numeric / r);
      v := u * m."quantity";
    ELSE
      u := CASE WHEN b_qty > 0 THEN round(b_val::numeric / b_qty) ELSE 0 END;
      v := u * m."quantity";
    END IF;

    INSERT INTO "_bal" VALUES (m."variant_id", m."location_id", b_qty + m."quantity", b_val + v)
      ON CONFLICT ("variant_id", "location_id")
      DO UPDATE SET "qty" = EXCLUDED."qty", "val" = EXCLUDED."val";

    UPDATE "inventory_movements"
      SET "unit_cost_base_amount" = u, "value_base_amount" = v,
          "rate_to_base" = CASE WHEN m."unit_cost_amount" IS NULL THEN NULL ELSE r END
      WHERE "id" = m."id";
  END LOOP;

  ALTER TABLE "inventory_movements" ENABLE TRIGGER "trg_inventory_movements_append_only";

  IF EXISTS (
    SELECT 1 FROM "inventory_balances" b
    LEFT JOIN "_bal" x ON x."variant_id" = b."variant_id" AND x."location_id" = b."location_id"
    WHERE b."quantity" <> coalesce(x."qty", 0)
  ) THEN
    RAISE EXCEPTION 'Replayed ledger quantities do not match the balances';
  END IF;

  UPDATE "inventory_balances" b SET "value_base_amount" = x."val"
    FROM "_bal" x WHERE x."variant_id" = b."variant_id" AND x."location_id" = b."location_id";
END $$;
