import { expect, test, type Page } from '@playwright/test';
import { ensureOptionType } from './setup';

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

  // ── A category, then its products by tapping options (ADR-011) ─────────────────────────
  const types = { القماش: ['قطني'], اللون: ['أبيض', 'أسود'], القياس: ['54', '56'] };
  for (const [name, values] of Object.entries(types)) {
    await ensureOptionType(page.request, name, values);
  }
  await page.getByRole('link', { name: 'المنتجات' }).click();
  await page.getByLabel('اسم التصنيف').fill('ثوب اختبار شامل');
  // Only these three types, whatever else exists on the test database.
  const form = page.locator('form').filter({ has: page.getByLabel('اسم التصنيف') });
  // The type chips arrive with the option list; read them only once they are there.
  await expect(form.getByRole('button', { name: 'القياس', exact: true })).toBeVisible();
  for (;;) {
    const pressed = await form.locator('button[aria-pressed="true"]').allInnerTexts();
    const extra = pressed.map((t) => t.trim()).find((name) => !(name in types));
    if (!extra) break;
    await form.getByRole('button', { name: extra, exact: true }).click();
  }
  for (const name of Object.keys(types)) {
    const chip = form.getByRole('button', { name, exact: true });
    if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
  }
  await page.getByRole('button', { name: 'إضافة التصنيف' }).click();
  await expect(page.getByRole('heading', { name: /ثوب اختبار شامل/ })).toBeVisible();

  for (const [name, values] of Object.entries(types)) {
    for (const value of values) {
      await page
        .getByRole('group', { name })
        .getByRole('button', { name: value, exact: true })
        .click();
    }
  }
  await expect(page.getByText('2 تصميم × 2 مقاس')).toBeVisible();
  await page.getByRole('button', { name: 'إنشاء 4 مقاس' }).click();
  await expect(page.getByText('أُنشئ 4 مقاس في 2 منتج')).toBeVisible();
  await page.screenshot({ path: `${shots}/3-variants.png` });

  // ── One product: its sizes and their barcodes ───────────────────────────────────────────
  await page.getByRole('link', { name: 'قطني · أبيض' }).click();
  await expect(page.getByRole('heading', { name: 'المقاسات' })).toBeVisible();
  const barcodes = await page.locator('tbody tr td:nth-child(3)').allInnerTexts();
  expect(barcodes).toHaveLength(2);
  for (const b of barcodes) expect(b.trim()).toMatch(/^200\d{10}$/);
  const [first, second] = barcodes.map((b) => b.trim()) as [string, string];

  // ── Labels ──────────────────────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'طباعة الملصقات' }).click();
  await expect(page.getByRole('button', { name: 'طباعة 2 ملصق' })).toBeVisible();
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
  await page.getByLabel('بحث').fill('ثوب اختبار شامل');
  await page.screenshot({ path: `${shots}/8-balances.png` });
});
