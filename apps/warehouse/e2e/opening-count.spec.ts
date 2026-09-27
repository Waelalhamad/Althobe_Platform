import { expect, test, type Page } from '@playwright/test';

// Phase 2 done-criterion (PROJECT_STATUS / plan §7): someone logs in, creates a product, prints
// its labels, scans an opening count at WH1, and sees the correct balance — in RTL Arabic.

const EMAIL = process.env.E2E_EMAIL ?? 'tester@althobe.local';
const PASSWORD = process.env.E2E_PASSWORD ?? '';
const shots = 'e2e/screenshots';

async function scan(page: Page, barcode: string) {
  // A keyboard-wedge scanner types digits and presses Enter into the focused scan field.
  await page.keyboard.type(barcode, { delay: 5 });
  await page.keyboard.press('Enter');
}

test('opening count by scanner, end to end', async ({ page }) => {
  test.skip(!PASSWORD, 'Set E2E_PASSWORD (and E2E_EMAIL) for a login on the TEST database');
  const code = `E2E-${Date.now().toString(36).toUpperCase()}`;

  // ── Log in ──────────────────────────────────────────────────────────────────────────────
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.getByLabel('البريد الإلكتروني').fill(EMAIL);
  await page.getByLabel('كلمة المرور').fill(PASSWORD);
  await page.screenshot({ path: `${shots}/1-login.png` });
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page.getByRole('heading', { name: 'المواقع' })).toBeVisible();
  expect(
    await page.evaluate(
      async () => (await document.fonts.ready, document.fonts.check('16px Somar')),
    ),
  ).toBe(true);
  await page.screenshot({ path: `${shots}/2-home.png` });

  // ── Create a product and its variants ───────────────────────────────────────────────────
  await page.getByRole('link', { name: 'المنتجات' }).click();
  await page.getByLabel('رمز المنتج').fill(code);
  await page.getByLabel('اسم المنتج').fill('ثوب اختبار شامل');
  await page.getByRole('button', { name: 'إضافة منتج' }).click();
  await expect(page.getByRole('heading', { name: /ثوب اختبار شامل/ })).toBeVisible();

  await page.getByLabel('الأقمشة').fill('قطني');
  await page.getByLabel('الألوان').fill('أبيض، أسود');
  await page.getByLabel('القياسات').fill('54، 56');
  await page.getByRole('button', { name: 'إنشاء 4 صنف' }).click();
  await expect(page.getByText('أُنشئ 4 صنف جديد')).toBeVisible();
  const barcodes = await page.locator('tbody tr td:nth-child(5)').allInnerTexts();
  expect(barcodes).toHaveLength(4);
  for (const b of barcodes) expect(b.trim()).toMatch(/^200\d{10}$/);
  await page.screenshot({ path: `${shots}/3-variants.png` });
  const [first, second] = barcodes.map((b) => b.trim()) as [string, string];

  // ── Labels ──────────────────────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'طباعة الملصقات' }).click();
  await expect(page.getByRole('button', { name: 'طباعة 4 ملصق' })).toBeVisible();
  await expect(page.locator('svg').first()).toBeVisible();
  await page.screenshot({ path: `${shots}/4-labels.png` });

  // ── Opening count at WH1 ────────────────────────────────────────────────────────────────
  await page.getByRole('link', { name: 'الرئيسية' }).click();
  const wh1 = page
    .locator('div.rounded-xl')
    .filter({ has: page.getByRole('heading', { name: 'المخزن الرئيسي' }) });
  await wh1.getByRole('button', { name: 'جرد افتتاحي' }).click();
  await expect(page.getByRole('heading', { name: /جرد افتتاحي — المخزن الرئيسي/ })).toBeVisible();

  for (let i = 0; i < 37; i++) await scan(page, first);
  await expect(page.locator('.text-5xl')).toHaveText('37', { timeout: 480_000 });
  await page.screenshot({ path: `${shots}/5-scanning.png` });

  // A carton: scan once, then type the quantity.
  await scan(page, second);
  await expect(page.locator('.text-5xl')).toHaveText('1');
  const qty = page.locator('tbody tr').nth(1).locator('input[type="number"]');
  await qty.fill('20');
  await qty.press('Enter');
  await expect(page.getByText('المجموع: 57 قطعة · 2 صنف')).toBeVisible();

  // An unknown barcode is refused and says so.
  await scan(page, '2009999999997');
  await expect(page.getByText('الباركود غير معروف')).toBeVisible();
  await page.screenshot({ path: `${shots}/6-before-commit.png` });

  const confirm = page.getByRole('button', { name: 'تأكيد وحفظ في المخزون' });
  await confirm.click();
  await page.getByRole('button', { name: 'اضغط مرة أخرى للتأكيد' }).click();
  await expect(page.getByText(/تم الحفظ في المخزون: 57 قطعة في 2 صنف/)).toBeVisible();
  await page.screenshot({ path: `${shots}/7-committed.png` });

  // ── The balance is right ────────────────────────────────────────────────────────────────
  await page.getByRole('link', { name: 'الأرصدة' }).click();
  await page.getByLabel('الموقع').selectOption({ label: 'المخزن الرئيسي' });
  await page.getByLabel('بحث').fill(first);
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr td').nth(3)).toHaveText('37');
  await page.getByLabel('بحث').fill(second);
  await expect(page.locator('tbody tr td').nth(3)).toHaveText('20');
  await page.getByLabel('بحث').fill(code);
  await page.screenshot({ path: `${shots}/8-balances.png` });
});
