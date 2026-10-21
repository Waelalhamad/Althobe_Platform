import type { MovementView } from '../inventory/inventory.service.js';
import type { Branch, DraftEntry } from './accounting.types.js';
import { businessDate, line, lineAtBase } from './posting.js';

export const INVENTORY_SOURCE = 'INVENTORY_MOVEMENT';

/** The accounts stock movements post to. */
export interface InventoryAccounts {
  byLocation: Map<string, { id: string; branch: Branch | null }>;
  transit: string;
  payable: string;
  openingEquity: string;
  cogs: string;
  damage: string;
  adjustment: string;
}

const MEMO: Record<MovementView['type'], string> = {
  OPENING: 'جرد افتتاحي',
  PURCHASE: 'استلام بضاعة',
  SALE: 'بيع / إخراج',
  RETURN: 'مرتجع',
  TRANSFER_OUT: 'نقل — خروج',
  TRANSFER_IN: 'نقل — دخول',
  ADJUSTMENT: 'تعديل مخزون',
  DAMAGE: 'تالف',
  STOCKTAKE: 'فرق جرد',
};

/**
 * ADR-013 posting rules. The ledger copies the USD value the stock ledger already stored on the
 * movement and never recomputes a cost. The inventory account of the movement's location takes
 * the value (debit in, credit out); the other side depends on the type:
 *
 *   OPENING      ↔ opening balances         PURCHASE  ↔ suppliers (what we owe for the goods)
 *   SALE, RETURN ↔ cost of goods sold       DAMAGE    ↔ damaged goods
 *   ADJUSTMENT, STOCKTAKE ↔ stock differences
 *   TRANSFER_OUT / TRANSFER_IN ↔ goods in transit (the two halves cancel out)
 *
 * A movement worth nothing (e.g. stock that came in without a cost) posts nothing.
 */
export function entryForMovement(m: MovementView, accounts: InventoryAccounts): DraftEntry | null {
  const value = m.valueBaseAmount;
  if (value === null || value === 0n) return null;
  const inventory = accounts.byLocation.get(m.locationId);
  if (!inventory) throw new Error(`no inventory account for location ${m.locationId}`);

  const extra = { branch: inventory.branch, locationId: m.locationId };
  const counterAccount = counterFor(m.type, accounts);
  // A purchase in SYP or LYD keeps what is owed in that currency, at the rate of the delivery.
  const counter =
    m.type === 'PURCHASE' && m.unitCost && m.unitCost.currency !== 'USD'
      ? lineAtBase(
          counterAccount,
          m.unitCost.currency,
          -(m.unitCost.amount * BigInt(m.quantity)),
          -value,
          extra,
        )
      : line(counterAccount, 'USD', -value, '1', extra);

  const details = [m.reason, m.note].filter(Boolean).join(' — ');
  return {
    voucherType: 'INVENTORY',
    entryDate: businessDate(m.createdAt),
    memo: `${MEMO[m.type]} · ${pieces(Math.abs(m.quantity))}${details ? ` · ${details}` : ''}`,
    sourceType: INVENTORY_SOURCE,
    sourceId: m.id,
    createdById: m.createdById,
    lines: [line(inventory.id, 'USD', value, '1', extra), counter],
  };
}

/** قطعة واحدة · قطعتان · 3–10 قطع · 11 قطعة وما فوق (developer report F-13). */
export function pieces(n: number): string {
  if (n === 1) return 'قطعة واحدة';
  if (n === 2) return 'قطعتان';
  const lastTwo = n % 100;
  return lastTwo >= 3 && lastTwo <= 10 ? `${n} قطع` : `${n} قطعة`;
}

function counterFor(type: MovementView['type'], a: InventoryAccounts): string {
  switch (type) {
    case 'OPENING':
      return a.openingEquity;
    case 'PURCHASE':
      return a.payable;
    case 'SALE':
    case 'RETURN':
      return a.cogs;
    case 'DAMAGE':
      return a.damage;
    case 'ADJUSTMENT':
    case 'STOCKTAKE':
      return a.adjustment;
    case 'TRANSFER_OUT':
    case 'TRANSFER_IN':
      return a.transit;
  }
}
