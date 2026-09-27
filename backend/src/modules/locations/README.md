# Locations Module

## Responsibility

The physical places that hold stock, each with a `kind`: `WAREHOUSE` or `STORE`. Today WH1, WH2,
and STORE (placeholder names). Later: bins (shelves) inside warehouses.

## Depends On

- nothing

## Used By

- inventory — `locationsByIds`; the movement policy per kind lives in `inventory.policy.ts`

## Important Rules

- A store is not a warehouse with a label: behaviour differs by `kind`.
- "Bin" is reserved for shelves inside a warehouse — never use "location" for that.

## Main Services

```
listLocations  getLocation
```
