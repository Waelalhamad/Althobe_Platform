# Parties Module

## Responsibility

Suppliers and customers: what is owed both ways, and their statements (ADR-016).

## Depends On

- `accounting`: `postPartyEntry`, `todayValue`, `todayAmount`, `cashBox`, `balanceOfRole`,
  `syncInventory`.
- `inventory` (scan sessions): `commitInTx`, so a bill or a wholesale invoice is recorded with
  the goods or not at all.

## Used By

- `retail`: `customerForSale`, `recordPosSale`, `recordPosRefund` (على الحساب).
- The warehouse app: «المالية» → «الموردون والزبائن» (`/finance/parties`), the receipt and
  goods-out screens, and the till.

## Important Rules

- Amounts are minor units of the party's currency; `amount_base` is USD cents.
- `party_entries` is append-only. A party's balance is the sum of its rows; one row per kind per
  source (`uq_party_entries_source`).
- Settling clears the carried value in proportion (`settledBase`); a box is valued today; the
  difference is an exchange difference.
- 1103 and 2101 move only through this module, or through the stock ledger for purchases.
- A party changes under a row lock.

## Main Services

```
listParties  getParty  createParty  updateParty  settle
commitReceipt  commitGoodsOut  summary  settleUnassigned
customerForSale  recordPosSale  recordPosRefund   (trusted, for retail)
```

## Tests

- `parties-money.unit.test.ts`: settling in proportion, and beyond the balance.
- `parties.int.test.ts`:
  - a credit receipt paid in another currency after a rate change;
  - cash at a receipt, and the unnamed balance closed;
  - currency and kind refusals;
  - wholesale goods out;
  - a store sale on account, its refund, the shift close, and collecting the rest;
  - who may do what.
