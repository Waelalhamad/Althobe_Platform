-- «تراجع» (owner, 2026-10-23): the owner undoes a manual adjustment or a damage write-off. The
-- undo is a new movement of the same type with the opposite quantity and exactly the opposite
-- value, so stock and the books return to what they were; both stay in the history.
ALTER TABLE "inventory_movements"
  ADD COLUMN "reverses_id" UUID,
  ADD CONSTRAINT "uq_inventory_movements_reverses_id" UNIQUE ("reverses_id"),
  ADD CONSTRAINT "inventory_movements_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "inventory_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A damage write-off undone puts pieces back: the only signed DAMAGE is an undo.
ALTER TABLE "inventory_movements" DROP CONSTRAINT "ck_inventory_movements_sign",
  ADD CONSTRAINT "ck_inventory_movements_sign" CHECK (
    ("type" IN ('OPENING', 'PURCHASE', 'RETURN', 'TRANSFER_IN') AND "quantity" > 0)
    OR ("type" IN ('SALE', 'TRANSFER_OUT', 'DAMAGE') AND "quantity" < 0)
    OR ("type" IN ('ADJUSTMENT', 'STOCKTAKE', 'RECEIPT_CORRECTION'))
    OR ("type" = 'DAMAGE' AND "reverses_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "ck_inventory_movements_undo_type" CHECK (
    "reverses_id" IS NULL OR "type" IN ('ADJUSTMENT', 'DAMAGE')
  );
