import { divRoundHalfUp } from '../../shared/money.js';

/**
 * The USD value that settling `part` takes off a balance of `owed` worth `owedBase`. In
 * proportion while it fits (the whole balance clears exactly); what goes beyond the balance,
 * or settles when nothing is owed, is a prepayment worth `partToday` pro rata, today's value.
 */
export function settledBase(
  owed: bigint,
  owedBase: bigint,
  part: bigint,
  partToday: bigint,
): bigint {
  if (owed <= 0n) return partToday;
  if (part <= owed) return part === owed ? owedBase : divRoundHalfUp(owedBase * part, owed);
  return owedBase + divRoundHalfUp(partToday * (part - owed), part);
}
