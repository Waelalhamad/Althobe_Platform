import { describe, expect, it } from 'vitest';
import type { MovementView } from '../inventory/inventory.service.js';
import { DEFAULT_CHART, parentCodeOf } from './chart.js';
import { entryForMovement, type InventoryAccounts } from './inventory-posting.js';
import { businessDate, impliedRate, line, monthEnd } from './posting.js';
import { revaluationLines } from './revaluation.js';

const accounts: InventoryAccounts = {
  byLocation: new Map([
    ['wh1', { id: 'inv-wh1', branch: 'SY' }],
    ['store', { id: 'inv-store', branch: 'SY' }],
  ]),
  transit: 'transit',
  payable: 'payable',
  openingEquity: 'opening',
  cogs: 'cogs',
  damage: 'damage',
  adjustment: 'adjustment',
};

function movement(overrides: Partial<MovementView>): MovementView {
  return {
    id: 'm1',
    seq: 1n,
    variantId: 'v',
    locationId: 'wh1',
    type: 'PURCHASE',
    quantity: 10,
    balanceAfter: 10,
    referenceType: 'SCAN_SESSION',
    referenceId: null,
    transferId: null,
    reason: null,
    note: null,
    unitCost: { amount: 1_000n, currency: 'USD', rateToBase: '1' },
    unitCostBaseAmount: 1_000n,
    valueBaseAmount: 10_000n,
    createdById: 'u',
    createdAt: new Date('2026-10-19T09:00:00Z'),
    ...overrides,
  };
}

const sides = (entry: ReturnType<typeof entryForMovement>) =>
  entry!.lines.map((l) => [l.accountId, l.amountBase]);

describe('posting rules for stock movements (ADR-013)', () => {
  it('a purchase debits the location’s stock and credits suppliers, at the stored value', () => {
    const entry = entryForMovement(movement({}), accounts);
    expect(sides(entry)).toEqual([
      ['inv-wh1', 10_000n],
      ['payable', -10_000n],
    ]);
    expect(entry).toMatchObject({
      voucherType: 'INVENTORY',
      sourceType: 'INVENTORY_MOVEMENT',
      sourceId: 'm1',
      entryDate: '2026-10-19',
    });
  });

  it('a purchase in SYP keeps what is owed in SYP, worth the same USD value', () => {
    const entry = entryForMovement(
      movement({
        unitCost: { amount: 1_220_000n, currency: 'SYP', rateToBase: '122' },
        valueBaseAmount: 100_000n,
      }),
      accounts,
    );
    expect(entry!.lines[1]).toMatchObject({
      accountId: 'payable',
      currency: 'SYP',
      amountCurrency: -12_200_000n,
      amountBase: -100_000n,
      rate: '122',
    });
  });

  it('a sale moves its value from stock to cost of goods sold; a return moves it back', () => {
    expect(
      sides(
        entryForMovement(
          movement({ type: 'SALE', quantity: -2, valueBaseAmount: -2_000n }),
          accounts,
        ),
      ),
    ).toEqual([
      ['inv-wh1', -2_000n],
      ['cogs', 2_000n],
    ]);
    expect(
      sides(
        entryForMovement(
          movement({ type: 'RETURN', quantity: 1, valueBaseAmount: 1_000n }),
          accounts,
        ),
      ),
    ).toEqual([
      ['inv-wh1', 1_000n],
      ['cogs', -1_000n],
    ]);
  });

  it('a transfer goes through goods in transit, and the two halves cancel', () => {
    const out = entryForMovement(
      movement({ type: 'TRANSFER_OUT', quantity: -3, valueBaseAmount: -3_000n }),
      accounts,
    );
    const into = entryForMovement(
      movement({
        id: 'm2',
        type: 'TRANSFER_IN',
        locationId: 'store',
        quantity: 3,
        valueBaseAmount: 3_000n,
      }),
      accounts,
    );
    expect(sides(out)).toEqual([
      ['inv-wh1', -3_000n],
      ['transit', 3_000n],
    ]);
    expect(sides(into)).toEqual([
      ['inv-store', 3_000n],
      ['transit', -3_000n],
    ]);
  });

  it('damage, adjustments and opening stock post to their own accounts', () => {
    const counter = (type: MovementView['type'], value: bigint) =>
      entryForMovement(movement({ type, valueBaseAmount: value }), accounts)!.lines[1]!.accountId;
    expect(counter('DAMAGE', -1n)).toBe('damage');
    expect(counter('ADJUSTMENT', 1n)).toBe('adjustment');
    expect(counter('STOCKTAKE', -1n)).toBe('adjustment');
    expect(counter('OPENING', 1n)).toBe('opening');
  });

  it('a movement worth nothing posts nothing', () => {
    expect(entryForMovement(movement({ valueBaseAmount: 0n }), accounts)).toBeNull();
  });

  it('dates entries by the calendar in Damascus, not UTC', () => {
    // 22:30 UTC on 31 October is already 1 November in Damascus (UTC+3).
    expect(businessDate(new Date('2026-10-31T22:30:00Z'))).toBe('2026-11-01');
  });
});

describe('money lines', () => {
  it('values SYP and LYD at the rate, and keeps USD exact', () => {
    expect(line('a', 'SYP', 12_200_000n, '122').amountBase).toBe(100_000n);
    expect(line('a', 'LYD', -6_380_000n, '6.38').amountBase).toBe(-100_000n);
    expect(line('a', 'USD', 1_234n, '1')).toMatchObject({ amountBase: 1_234n, rate: '1' });
  });

  it('derives the rate of a deal from its two amounts', () => {
    // 1,250,000.00 SYP for 100.00 USD: 12,500 per dollar.
    expect(impliedRate(125_000_000n, 'SYP', 10_000n)).toBe('12500');
    expect(impliedRate(6_400n, 'LYD', 100n)).toBe('6.4');
  });
});

describe('month-end revaluation', () => {
  it('restates SYP held at the closing rate and books the difference per country', () => {
    // 10,000.00 SYP bought for 100.00 USD (rate 100); at 125 it is worth 80.00 USD.
    const lines = revaluationLines(
      [
        {
          accountId: 'box',
          currency: 'SYP',
          branch: 'SY',
          balanceCurrency: 1_000_000n,
          balanceBase: 10_000n,
        },
        { accountId: 'usd', currency: 'LYD', branch: 'LY', balanceCurrency: 0n, balanceBase: 0n },
      ],
      new Map([
        ['SYP', '125'],
        ['LYD', '6.4'],
      ]),
      'fx',
    );
    expect(lines).toEqual([
      {
        accountId: 'box',
        currency: 'SYP',
        amountCurrency: 0n,
        amountBase: -2_000n,
        rate: '125',
        branch: 'SY',
      },
      {
        accountId: 'fx',
        currency: 'USD',
        amountCurrency: 2_000n,
        amountBase: 2_000n,
        rate: '1',
        branch: 'SY',
      },
    ]);
  });

  it('posts nothing when the books already match the rate', () => {
    expect(
      revaluationLines(
        [
          {
            accountId: 'box',
            currency: 'SYP',
            branch: 'SY',
            balanceCurrency: 1_000_000n,
            balanceBase: 8_000n,
          },
        ],
        new Map([['SYP', '125']]),
        'fx',
      ),
    ).toEqual([]);
  });
});

describe('chart of accounts', () => {
  it('has unique codes, and every account but the classes has a parent', () => {
    const codes = DEFAULT_CHART.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      if (code.length > 1) expect(parentCodeOf(code, codes), code).not.toBeNull();
    }
    expect(parentCodeOf('110101', codes)).toBe('1101');
  });

  it('gives every cash box one currency, and names each account code posts to once', () => {
    for (const a of DEFAULT_CHART.filter((d) => d.kind === 'CASH'))
      expect(a.currency).toBeDefined();
    const roles = DEFAULT_CHART.flatMap((a) => (a.role ? [a.role] : []));
    expect(new Set(roles).size).toBe(roles.length);
  });

  it('knows the last day of each month', () => {
    expect(monthEnd('2026-02')).toBe('2026-02-28');
    expect(monthEnd('2028-02')).toBe('2028-02-29');
    expect(monthEnd('2026-10')).toBe('2026-10-31');
  });
});
