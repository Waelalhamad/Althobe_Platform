import type { MovementType, ReferenceType } from '@prisma/client';
import type { Currency, UnitCost } from '../../shared/money.js';

export interface BalanceKey {
  variantId: string;
  locationId: string;
}

/** One requested change to the ledger. Built by service operations, applied by applyMovements. */
export interface MovementEntry extends BalanceKey {
  type: MovementType;
  /** Signed. Positive adds stock, negative removes it. Never zero. */
  quantity: number;
  referenceType: ReferenceType;
  referenceId?: string | null;
  transferId?: string | null;
  reason?: string | null;
  note?: string | null;
  /** Explicit cost for an inbound movement. Without it, inbound stock enters at the current average. */
  unitCost?: UnitCost | null;
  /** TRANSFER_IN only: index of its TRANSFER_OUT in the same call. The value moves with the goods. */
  pairedWith?: number;
}

export interface BalanceView extends BalanceKey {
  quantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  /** Total stock value, SYP minor units. Null when the actor cannot see costs. */
  valueBaseAmount: bigint | null;
  /** Moving weighted average unit cost, SYP minor units. Null when the actor cannot see costs. */
  averageCostBaseAmount: bigint | null;
}

export interface MovementView extends BalanceKey {
  id: string;
  seq: bigint;
  type: MovementType;
  quantity: number;
  balanceAfter: number;
  referenceType: ReferenceType;
  referenceId: string | null;
  transferId: string | null;
  reason: string | null;
  note: string | null;
  unitCost: { amount: bigint; currency: Currency; rateToBase: string } | null;
  unitCostBaseAmount: bigint | null;
  valueBaseAmount: bigint | null;
  createdById: string;
  createdAt: Date;
}

export interface LedgerResult {
  movements: MovementView[];
  balances: BalanceView[];
}
