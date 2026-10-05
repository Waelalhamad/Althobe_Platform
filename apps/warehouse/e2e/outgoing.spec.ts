import { expect, test, type Page } from '@playwright/test';
import { api, productWithSizes } from './setup';

// Goods leaving to customers (إخراج / بيع) and coming back (مرتجع), at the store.

const EMAIL = process.env.E2E_EMAIL ?? 'tester@althobe.local';
const PASSWORD = process.env.E2E_PASSWORD ?? '';
const shots = 'e2e/screenshots/outgoing';

async function scan(page: Page, barcode: string) {
  await page.keyboard.type(barcode, { delay: 5 });
  await page.keyboard.press('Enter');
}

async function confirm(page: Page) {
  await page.getByRole('button', { name: 'تأكيد وحفظ في المخزون' }).click();
  await page.getByRole('button', { name: 'اضغط مرة أخرى للتأكيد' }).click();
}

test('sale and return at the store keep the balance true', async ({ page }) => {
  test.skip(!PASSWORD, 'Set E2E_PASSWORD (and E2E_EMAIL) for an owner login on the TEST database');
  const code = `OUT-${Date.now().toString(36).toUpperCase()}`;
  const invoice = `فاتورة ${code}`;
  const reason = `مقاس غير مناسب ${code}`;

  await page.goto('/login');
  await page.getByLabel('البريد الإلكتروني').fill(EMAIL);
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page.getByRole('heading', { name: 'المواقع' })).toBeVisible();

  // ── Setup through the API: 10 at WH1, 5 of them moved to the store ────────────────────────
  const rq = page.request;
  const locations = await api<{ id: string; code: string }[]>(rq, 'GET', '/locations');
  const wh1 = locations.find((l) => l.code === 'WH1')!;
  const store = locations.find((l) => l.code === 'STORE')!;
  const created = await productWithSizes(rq, code, 'ثوب اختبار البيع', ['56']);
  const a = created[0]!;
  const opening = await api<{ id: string }>(rq, 'POST', '/scan-sessions', {
    kind: 'OPENING',
    locationId: wh1.id,
  });
  await api(rq, 'POST', `/scan-sessions/${opening.id}/scans`, {
    barcode: a.barcode,
    scanId: crypto.randomUUID(),
  });
  await api(rq, 'PATCH', `/scan-sessions/${opening.id}/lines/${a.id}`, { quantity: 10 });
  await api(rq, 'POST', `/scan-sessions/${opening.id}/commit`);
  const transfer = await api<{ id: string }>(rq, 'POST', '/scan-sessions', {
    kind: 'TRANSFER',
    locationId: wh1.id,
    toLocationId: store.id,
  });
  await api(rq, 'POST', `/scan-sessions/${transfer.id}/scans`, {
    barcode: a.barcode,
    scanId: crypto.randomUUID(),
  });
  await api(rq, 'PATCH', `/scan-sessions/${transfer.id}/lines/${a.id}`, { quantity: 5 });
  await api(rq, 'POST', `/scan-sessions/${transfer.id}/commit`);
  await page.reload();

  const storeCard = page
    .locator('div.rounded-xl')
    .filter({ has: page.getByRole('heading', { name: 'المتجر' }) });

  // ── Sale of 2, with the invoice as the note ───────────────────────────────────────────────
  await storeCard.getByRole('button', { name: 'إخراج / بيع' }).click();
  await storeCard.getByRole('textbox').fill(invoice);
  await storeCard.getByRole('button', { name: 'ابدأ الإخراج' }).click();
  await expect(page.getByRole('heading', { name: /إخراج \/ بيع — المتجر/ })).toBeVisible();
  await expect(page.getByText(`العميل / ملاحظة: ${invoice}`)).toBeVisible();
  await expect(page.getByText(/أكّد بعد كل زبون أو فاتورة/)).toBeVisible();

  await scan(page, a.barcode);
  await scan(page, a.barcode);
  await expect(page.locator('.text-5xl')).toHaveText('2', { timeout: 120_000 });
  await expect(page.getByRole('columnheader', { name: 'المتوفر' })).toBeVisible();
  await page.screenshot({ path: `${shots}/1-sale.png` });
  await confirm(page);
  await expect(page.getByText(/تم الحفظ في المخزون: 2 قطعة/)).toBeVisible();

  // ── An over-sale (9 of 3 left) cannot be confirmed ────────────────────────────────────────
  await page.getByRole('link', { name: 'الرئيسية' }).click();
  await storeCard.getByRole('button', { name: 'إخراج / بيع' }).click();
  await storeCard.getByRole('button', { name: 'ابدأ الإخراج' }).click();
  // Scan only once the session screen is up; keystrokes during navigation go nowhere.
  await expect(page.getByRole('heading', { name: /إخراج \/ بيع — المتجر/ })).toBeVisible();
  await scan(page, a.barcode);
  await expect(page.locator('.text-5xl')).toHaveText('1', { timeout: 120_000 });
  const qty = page.locator('tbody tr').first().locator('input[type="number"]');
  await qty.fill('9');
  await qty.press('Enter');
  await expect(page.getByText(/صنف بكمية أكبر من المتوفر/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'تأكيد وحفظ في المخزون' })).toBeDisabled();
  await page.getByRole('button', { name: 'إلغاء الجلسة' }).click();
  await page.getByRole('button', { name: 'اضغط مرة أخرى للتأكيد' }).click();
  await expect(page.getByRole('heading', { name: 'المواقع' })).toBeVisible();

  // ── Return of 1, with a reason ────────────────────────────────────────────────────────────
  await storeCard.getByRole('button', { name: 'مرتجع' }).click();
  await expect(storeCard.getByRole('button', { name: 'ابدأ المرتجع' })).toBeDisabled();
  await storeCard.getByPlaceholder('مثال: مقاس غير مناسب').fill(reason);
  await storeCard.getByRole('button', { name: 'ابدأ المرتجع' }).click();
  await expect(page.getByRole('heading', { name: /مرتجع — المتجر/ })).toBeVisible();
  await scan(page, a.barcode);
  await expect(page.locator('.text-5xl')).toHaveText('1', { timeout: 120_000 });
  await confirm(page);
  await expect(page.getByText(/تم الحفظ في المخزون: 1 قطعة/)).toBeVisible();

  // ── Balance 5 − 2 + 1 = 4, and the history tells the story ───────────────────────────────
  await page.getByRole('link', { name: 'الأرصدة' }).click();
  await page.getByLabel('الموقع').selectOption({ label: 'المتجر' });
  await page.getByLabel('بحث').fill(a.barcode);
  await expect(page.locator('tbody tr td').nth(3)).toHaveText('4');
  await page.locator('tbody').getByRole('link', { name: 'السجل' }).click();
  await expect(page.locator('tbody tr').filter({ hasText: invoice })).toContainText('بيع / إخراج');
  await expect(page.locator('tbody tr').filter({ hasText: reason })).toContainText('مرتجع');
  await page.screenshot({ path: `${shots}/2-history.png` });
});
