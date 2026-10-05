import { expect, test, type Page } from '@playwright/test';
import { api, productWithSizes } from './setup';

// Phase 3 screens: transfer, damage, stocktake, adjustment → history, report, users.
// Setup goes through the API (same session cookie) to keep the run short on a slow network.

const EMAIL = process.env.E2E_EMAIL ?? 'tester@althobe.local';
const PASSWORD = process.env.E2E_PASSWORD ?? '';
const shots = 'e2e/screenshots/phase3';

async function scan(page: Page, barcode: string) {
  await page.keyboard.type(barcode, { delay: 5 });
  await page.keyboard.press('Enter');
}

test('phase 3: transfer, damage, stocktake, adjust, history, report, users', async ({ page }) => {
  test.skip(!PASSWORD, 'Set E2E_PASSWORD (and E2E_EMAIL) for an owner login on the TEST database');
  const code = `P3-${Date.now().toString(36).toUpperCase()}`;

  // ── Log in and set up: a product with 2 variants, 10 + 5 opening stock at WH1 ─────────────
  await page.goto('/login');
  await page.getByLabel('البريد الإلكتروني').fill(EMAIL);
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page.getByRole('heading', { name: 'المواقع' })).toBeVisible();

  const rq = page.request;
  const locations = await api<{ id: string; code: string }[]>(rq, 'GET', '/locations');
  const wh1 = locations.find((l) => l.code === 'WH1')!;
  const created = await productWithSizes(rq, code, 'ثوب المرحلة الثالثة', ['54', '56']);
  const [a, b] = created as [{ id: string; barcode: string }, { id: string; barcode: string }];
  const opening = await api<{ id: string }>(rq, 'POST', '/scan-sessions', {
    kind: 'OPENING',
    locationId: wh1.id,
  });
  await api(rq, 'POST', `/scan-sessions/${opening.id}/scans`, {
    barcode: a.barcode,
    scanId: crypto.randomUUID(),
  });
  await api(rq, 'PATCH', `/scan-sessions/${opening.id}/lines/${a.id}`, { quantity: 10 });
  await api(rq, 'POST', `/scan-sessions/${opening.id}/scans`, {
    barcode: b.barcode,
    scanId: crypto.randomUUID(),
  });
  await api(rq, 'PATCH', `/scan-sessions/${opening.id}/lines/${b.id}`, { quantity: 5 });
  await api(rq, 'POST', `/scan-sessions/${opening.id}/commit`);
  await page.reload();

  const wh1Card = page
    .locator('div.rounded-xl')
    .filter({ has: page.getByRole('heading', { name: 'المخزن الرئيسي' }) });

  // ── Transfer 3 of A from WH1 to the store; an over-scan is blocked before confirming ──────
  await wh1Card.getByRole('button', { name: 'نقل بضاعة' }).click();
  await wh1Card.getByRole('combobox').selectOption({ label: 'المتجر' });
  await wh1Card.getByRole('button', { name: 'ابدأ النقل' }).click();
  await expect(
    page.getByRole('heading', { name: /نقل بضاعة — المخزن الرئيسي ← المتجر/ }),
  ).toBeVisible();

  for (let i = 0; i < 3; i++) await scan(page, a.barcode);
  await expect(page.locator('.text-5xl')).toHaveText('3', { timeout: 120_000 });
  await expect(page.getByRole('columnheader', { name: 'المتوفر' })).toBeVisible();

  // Scan B, then type 6 (only 5 exist): warning, and confirm is disabled.
  await scan(page, b.barcode);
  await expect(page.locator('.text-5xl')).toHaveText('1');
  const qtyB = page.locator('tbody tr').nth(1).locator('input[type="number"]');
  await qtyB.fill('6');
  await qtyB.press('Enter');
  await expect(page.getByText(/صنف بكمية أكبر من المتوفر/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'تأكيد وحفظ في المخزون' })).toBeDisabled();
  await page.screenshot({ path: `${shots}/1-transfer-overscan.png` });

  await qtyB.fill('2');
  await qtyB.press('Enter');
  await expect(page.getByText('المجموع: 5 قطعة · 2 صنف')).toBeVisible();
  await page.getByRole('button', { name: 'تأكيد وحفظ في المخزون' }).click();
  await page.getByRole('button', { name: 'اضغط مرة أخرى للتأكيد' }).click();
  await expect(page.getByText(/تم الحفظ في المخزون: 5 قطعة/)).toBeVisible();

  // ── Damage 1 of A at WH1, with a reason ────────────────────────────────────────────────────
  await page.getByRole('link', { name: 'الرئيسية' }).click();
  await wh1Card.getByRole('button', { name: 'تالف' }).click();
  await wh1Card.getByRole('textbox').fill('بلل أثناء التخزين');
  await wh1Card.getByRole('button', { name: 'ابدأ تسجيل التالف' }).click();
  await expect(page.getByText('السبب: بلل أثناء التخزين')).toBeVisible();
  await scan(page, a.barcode);
  await expect(page.locator('.text-5xl')).toHaveText('1');
  await page.getByRole('button', { name: 'تأكيد وحفظ في المخزون' }).click();
  await page.getByRole('button', { name: 'اضغط مرة أخرى للتأكيد' }).click();
  await expect(page.getByText(/تم الحفظ في المخزون: 1 قطعة/)).toBeVisible();
  // WH1 now: A = 10 − 3 − 1 = 6, B = 5 − 2 = 3.

  // ── Stocktake at WH1: blind count, review, and the creator cannot approve ─────────────────
  await page.getByRole('link', { name: 'الجرد' }).click();
  await page.getByLabel('الموقع').selectOption({ label: 'المخزن الرئيسي' });
  await page.getByRole('button', { name: 'بدء جرد جديد' }).click();
  await expect(page.getByRole('heading', { name: /جرد المخزن الرئيسي — قيد العد/ })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'المتوقع' })).toHaveCount(0); // blind
  const rowA = page.locator('tbody tr').filter({ hasText: a.barcode });
  await rowA.locator('input[type="number"]').fill('5');
  await rowA.locator('input[type="number"]').press('Enter');
  const rowB = page.locator('tbody tr').filter({ hasText: b.barcode });
  await rowB.locator('input[type="number"]').fill('3');
  await rowB.locator('input[type="number"]').press('Enter');
  // The finish button must wait for the typed counts to be saved (it is disabled meanwhile).
  await page.getByRole('button', { name: 'إنهاء العد والمراجعة' }).click();
  // Stock left at WH1 by earlier runs was not counted here: confirm it as zero to reach review.
  const confirmZero = page.getByRole('button', { name: 'اعتبار غير المعدود صفراً والمتابعة' });
  const reviewHeading = page.getByRole('heading', { name: /بانتظار الاعتماد/ });
  await expect(confirmZero.or(reviewHeading)).toBeVisible();
  if (await confirmZero.isVisible()) await confirmZero.click();
  await expect(reviewHeading).toBeVisible();
  // Review shows expected vs counted: A expected 6, counted 5 → −1; B expected 3, counted 3 → 0.
  await expect(page.locator('tbody tr').filter({ hasText: a.barcode })).toContainText('-1');
  await expect(page.getByText('أنشأتَ هذا الجرد، لذا يجب أن يعتمده شخص آخر.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'اعتماد وتطبيق الفروقات' })).toBeDisabled();
  await page.screenshot({ path: `${shots}/2-stocktake.png` });
  await page.getByRole('button', { name: 'إلغاء الجرد' }).click();
  await page.getByRole('button', { name: 'اضغط مرة أخرى للتأكيد' }).click();
  await expect(page.getByRole('heading', { name: 'الجرد', exact: true })).toBeVisible();

  // ── Adjust B by −1 from the balances page, then find it in the history ────────────────────
  await page.getByRole('link', { name: 'الأرصدة' }).click();
  await page.getByLabel('الموقع').selectOption({ label: 'المخزن الرئيسي' });
  await page.getByLabel('بحث').fill(b.barcode);
  await expect(page.locator('tbody tr td').nth(3)).toHaveText('3');
  await page.getByRole('button', { name: 'تعديل' }).click();
  await page.getByLabel('التغيير (+ أو −)').fill('-1');
  await page.getByLabel('السبب (إلزامي)').fill(`تصحيح : قطعة في كرتونة صنف آخر`);
  await page.getByRole('button', { name: 'حفظ التعديل' }).click();
  await expect(page.locator('tbody tr td').nth(3)).toHaveText('2');

  // The row's own link filters the history to this item at this location.
  await page.locator('tbody').getByRole('link', { name: 'السجل' }).click();
  await expect(page.getByRole('heading', { name: 'سجل الحركات' })).toBeVisible();
  const adjustment = page.locator('tbody tr').filter({ hasText: `تصحيح : قطعة في كرتونة صنف آخر` });
  await expect(adjustment).toContainText('تعديل');
  await expect(adjustment).toContainText('-1');
  await page.screenshot({ path: `${shots}/3-history.png` });

  // ── Report ─────────────────────────────────────────────────────────────────────────────────
  await page.getByRole('link', { name: 'التقارير' }).click();
  await expect(page.getByRole('heading', { name: 'تقرير المخزون' })).toBeVisible();
  await expect(page.getByText('ثوب المرحلة الثالثة').first()).toBeVisible();
  await page.screenshot({ path: `${shots}/4-report.png` });

  // ── Users: the owner creates a login; the one-time password is shown once ─────────────────
  await page.getByRole('link', { name: 'المستخدمون' }).click();
  await page.getByLabel('الاسم').fill('موظف اختبار');
  await page.getByLabel('البريد الإلكتروني').fill(`${code.toLowerCase()}@test.local`);
  await page.getByRole('button', { name: 'إضافة مستخدم' }).click();
  await expect(page.getByText(/كلمة مرور مؤقتة/)).toBeVisible();
  await page.screenshot({ path: `${shots}/5-users.png` });
});
