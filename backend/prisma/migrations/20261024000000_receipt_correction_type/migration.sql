-- Developer report F-02: a correction of a received line, signed, at the line's original cost.
-- On its own: Postgres does not let a new enum value be used in the transaction that adds it.
ALTER TYPE "movement_type" ADD VALUE 'RECEIPT_CORRECTION';
