import { expect, test } from '@playwright/test';
import { api, productWithSizes } from './setup';

// The till in three steps (ADR-014): scan → pay → done, and the screen is empty for the next
// customer. Runs against the TEST database with an owner login.

const EMAIL = process.env.E2E_EMAIL ?? 'tester@althobe.local';
const PASSWORD = process.env.E2E_PASSWORD ?? '';

test('scan, pay with a banknote, and the till is ready again', async ({ page }) => {
  test.skip(!PASSWORD, 'Set E2E_PASSWORD (and E2E_EMAIL) for an owner login on the TEST database');
  const code = `POS-${Date.now().toString(36).toUpperCase()}`;
  // Headless Chrome has no printer: count the prints instead.
  await page.addInitScript(() => {
    (window as unknown as { prints: number }).prints = 0;
    window.print = () => {
      (window as unknown as { prints: number }).prints += 1;
    };
  });

  await page.goto('/login');
  await page.getByLabel('البريد الإلكتروني').fill(EMAIL);
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page.getByRole('heading', { name: 'اليوم', exact: true })).toBeVisible();

  // ── Setup through the API: 3 pieces at the store at 1,220.00 ل.س, 122 ل.س to the dollar ──
  const rq = page.request;
  await api(rq, 'PUT', '/rates', { currency: 'SYP', rate: '122' });
  const locations = await api<{ id: string; code: string }[]>(rq, 'GET', '/locations');
  const wh1 = locations.find((l) => l.code === 'WH1')!;
  const store = locations.find((l) => l.code === 'STORE')!;
  const [piece] = await productWithSizes(rq, code, 'ثوب اختبار الصندوق', ['54']);
  const move = async (kind: 'OPENING' | 'TRANSFER', quantity: number) => {
    const s = await api<{ id: string }>(rq, 'POST', '/scan-sessions', {
      kind,
      locationId: wh1.id,
      ...(kind === 'TRANSFER' ? { toLocationId: store.id } : {}),
    });
    await api(rq, 'POST', `/scan-sessions/${s.id}/scans`, {
      barcode: piece!.barcode,
      scanId: crypto.randomUUID(),
    });
    await api(rq, 'PATCH', `/scan-sessions/${s.id}/lines/${piece!.id}`, {
      quantity,
      ...(kind === 'OPENING' ? { unitCost: { amount: '500', currency: 'USD' } } : {}),
    });
    await api(rq, 'POST', `/scan-sessions/${s.id}/commit`);
  };
  await move('OPENING', 3);
  await move('TRANSFER', 3);
  await api(rq, 'POST', '/variants/prices', { variantIds: [piece!.id], retailSyp: '122000' });

  // ── The shift opens from the last count, in one tap ─────────────────────────────────────────
  await page.goto('/pos');
  const start = page.getByRole('button', { name: 'ابدأ البيع' });
  if (await start.isVisible({ timeout: 15_000 }).catch(() => false)) await start.click();
  await expect(page.getByLabel('الباركود')).toBeFocused({ timeout: 30_000 });

  // ── Scan twice: one line of 2, the total in large figures ───────────────────────────────────
  for (let i = 0; i < 2; i++) {
    await page.keyboard.type(piece!.barcode, { delay: 5 });
    await page.keyboard.press('Enter');
    await expect(page.getByText('1,220 ل.س').or(page.getByText('2,440 ل.س')).first()).toBeVisible({
      timeout: 60_000,
    });
  }
  await expect(page.getByText('2,440 ل.س').first()).toBeVisible({ timeout: 60_000 });

  // ── Enter on the empty scanner box goes to the payment; 20 $ covers it with change ──────────
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: /^20 \$$/ }).click();
  // 20 $ = 2,440.00 ل.س: exactly the total.
  await expect(page.getByText('الباقي للزبون')).toBeVisible();
  await page.keyboard.press('Enter');

  // ── Done: the message, one print, and the till empty again ──────────────────────────────────
  await expect(page.getByText(/تم البيع — فاتورة/)).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(() => (window as unknown as { prints: number }).prints)).toBe(1);
  await page.getByRole('button', { name: /زبون جديد/ }).click();
  await expect(page.getByText('امسح أول قطعة')).toBeVisible();
  await expect(page.getByRole('link', { name: 'آخر فاتورة' })).toBeVisible();
});
