# Currency Module

## Responsibility

The owner's exchange rates (ADR-012): how many Syrian pounds (SYP) and Libyan dinars (LYD) make
1 US dollar. USD is the base currency: stock value, average cost and reports are in dollars.

## Depends On

- nothing

## Used By

- the warehouse app: a cost typed in SYP or LYD starts with the rate in force (the person can
  change it for that delivery). The rate a cost used is stamped on it, never looked up later.

## Important Rules

- A rate is units of the currency per 1 USD, `numeric(18,6)`, greater than zero.
- Only `admin.rates.write` (the owner) changes a rate; every change is in the audit log.
- Reading the rates needs only a signed-in user.

## Main Services

```
listRates  setRate
```
