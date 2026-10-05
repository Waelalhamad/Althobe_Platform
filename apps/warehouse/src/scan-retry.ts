import { ApiError } from './api';

// A scan must never be lost to a dropped connection. Every scan carries its own scanId, and the
// server counts a scanId once (unique per session), so resending a scan is always safe: if the
// first attempt did land, the resend comes back as a duplicate of itself and counts nothing extra.

/** Waits between attempts: about 40 s in total before giving up. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000, 15_000];

/** No answer, or the server or the network in between failed: worth trying again. */
export function isTransient(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true; // fetch itself failed: offline, reset, timeout
  return error.status >= 500 || error.status === 408 || error.code === 'NETWORK';
}

/**
 * Sends a scan, resending it while the failure is transient. Returns the result and whether it
 * needed a resend. A business refusal (unknown barcode, closed session…) is thrown at once.
 */
export async function sendScan<T>(
  send: () => Promise<T>,
  wait: (ms: number) => Promise<void> = async (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ result: T; resent: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return { result: await send(), resent: attempt > 0 };
    } catch (error) {
      const delay = BACKOFF_MS[attempt];
      if (!isTransient(error) || delay === undefined) throw error;
      await wait(delay);
    }
  }
}
