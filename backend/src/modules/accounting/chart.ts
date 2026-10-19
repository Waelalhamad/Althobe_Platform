import type { Tx } from '../../shared/db.js';
import type { Currency } from '../../shared/money.js';
import { uuidv7 } from '../../shared/ids.js';
import type { LocationView } from '../locations/locations.service.js';
import type { AccountKind, Branch, SystemRole } from './accounting.types.js';

interface AccountDef {
  code: string;
  nameAr: string;
  /** A heading groups accounts and takes no postings. */
  heading?: boolean;
  currency?: Currency;
  kind?: AccountKind;
  role?: SystemRole;
  branch?: Branch;
}

/**
 * دليل الحسابات الافتراضي (ADR-013): five classes, codes that grow with depth (1 → 11 → 1101 →
 * 110101), as in Arab accounting software. A parent is the account whose code is the longest
 * prefix. Installed once; the owner adds and renames accounts afterwards.
 */
export const DEFAULT_CHART: AccountDef[] = [
  { code: '1', nameAr: 'الأصول', heading: true },
  { code: '11', nameAr: 'الأصول المتداولة', heading: true },
  { code: '1101', nameAr: 'الصناديق', heading: true, role: 'CASH_PARENT' },
  {
    code: '110101',
    nameAr: 'صندوق المتجر — ليرة سورية',
    kind: 'CASH',
    currency: 'SYP',
    branch: 'SY',
    role: 'STORE_CASH_SYP',
  },
  {
    code: '110102',
    nameAr: 'صندوق المتجر — دولار',
    kind: 'CASH',
    currency: 'USD',
    branch: 'SY',
    role: 'STORE_CASH_USD',
  },
  {
    code: '110103',
    nameAr: 'صندوق ليبيا — دينار ليبي',
    kind: 'CASH',
    currency: 'LYD',
    branch: 'LY',
  },
  { code: '110104', nameAr: 'صندوق ليبيا — دولار', kind: 'CASH', currency: 'USD', branch: 'LY' },
  { code: '110105', nameAr: 'خزنة المالك — دولار', kind: 'CASH', currency: 'USD', branch: 'SY' },
  {
    code: '110106',
    nameAr: 'صندوق المتجر — ليرة تركية',
    kind: 'CASH',
    currency: 'TRY',
    branch: 'SY',
    role: 'STORE_CASH_TRY',
  },
  { code: '1103', nameAr: 'الزبائن (ذمم مدينة)', role: 'RECEIVABLE' },
  { code: '1104', nameAr: 'سلف الموظفين' },
  { code: '1105', nameAr: 'المخزون', heading: true, role: 'INVENTORY_PARENT' },
  {
    code: '110599',
    nameAr: 'بضاعة في الطريق بين المواقع',
    kind: 'INVENTORY',
    role: 'INVENTORY_TRANSIT',
  },
  { code: '12', nameAr: 'الأصول الثابتة', heading: true },
  { code: '1201', nameAr: 'الأثاث والمعدات' },

  { code: '2', nameAr: 'الخصوم', heading: true },
  { code: '21', nameAr: 'الخصوم المتداولة', heading: true },
  { code: '2101', nameAr: 'الموردون (ذمم دائنة)', role: 'PAYABLE' },
  { code: '2102', nameAr: 'رواتب مستحقة' },
  { code: '2103', nameAr: 'ضرائب ورسوم مستحقة' },
  { code: '2104', nameAr: 'دفعات مقدمة من الزبائن' },

  { code: '3', nameAr: 'حقوق الملكية', heading: true },
  { code: '3101', nameAr: 'رأس المال', role: 'CAPITAL' },
  { code: '3201', nameAr: 'جاري المالك', role: 'OWNER_CURRENT' },
  { code: '3301', nameAr: 'الأرباح المحتجزة', role: 'RETAINED' },
  { code: '3901', nameAr: 'أرصدة افتتاحية', role: 'OPENING_EQUITY' },

  { code: '4', nameAr: 'الإيرادات', heading: true },
  { code: '41', nameAr: 'المبيعات', heading: true },
  { code: '4101', nameAr: 'مبيعات المفرق — سوريا', branch: 'SY', role: 'RETAIL_SALES_SY' },
  { code: '4102', nameAr: 'مبيعات المفرق — ليبيا', branch: 'LY' },
  { code: '4103', nameAr: 'مبيعات الجملة' },
  { code: '4109', nameAr: 'مردودات المبيعات', role: 'SALES_RETURNS' },
  { code: '42', nameAr: 'إيرادات أخرى', heading: true },
  { code: '4201', nameAr: 'إيرادات متنوعة' },

  { code: '5', nameAr: 'المصاريف', heading: true },
  { code: '51', nameAr: 'تكلفة المبيعات', heading: true },
  { code: '5101', nameAr: 'تكلفة البضاعة المباعة', role: 'COGS' },
  { code: '5102', nameAr: 'بضاعة تالفة', role: 'DAMAGE' },
  { code: '5103', nameAr: 'فروقات الجرد والتعديلات', role: 'STOCK_ADJUSTMENT' },
  { code: '52', nameAr: 'المصاريف التشغيلية', heading: true },
  { code: '5201', nameAr: 'الإيجار' },
  { code: '5202', nameAr: 'الرواتب والأجور' },
  { code: '5203', nameAr: 'الكهرباء والمولدة' },
  { code: '5204', nameAr: 'النقل والشحن' },
  { code: '5205', nameAr: 'الجمارك والتخليص' },
  { code: '5206', nameAr: 'الاتصالات والإنترنت' },
  { code: '5207', nameAr: 'الصيانة' },
  { code: '5208', nameAr: 'عمولات التحويل والصرافة' },
  { code: '5209', nameAr: 'الضيافة والنظافة' },
  { code: '5210', nameAr: 'الدعاية والتسويق' },
  { code: '5211', nameAr: 'الضرائب والرسوم' },
  { code: '5298', nameAr: 'عجز وزيادة الصناديق', role: 'CASH_OVER_SHORT' },
  { code: '5299', nameAr: 'مصاريف متنوعة' },
  { code: '55', nameAr: 'فروقات الصرف', heading: true },
  { code: '5501', nameAr: 'فروقات صرف محققة', role: 'FX_REALIZED' },
  { code: '5502', nameAr: 'فروقات صرف غير محققة (إعادة التقييم)', role: 'FX_UNREALIZED' },
];

/** The parent code: the longest code in `codes` that is a strict prefix of `code`. */
export function parentCodeOf(code: string, codes: Iterable<string>): string | null {
  let best: string | null = null;
  for (const c of codes) {
    if (c.length < code.length && code.startsWith(c) && (!best || c.length > best.length)) best = c;
  }
  return best;
}

/**
 * Adds every missing default account, and an inventory account per location. Idempotent: an
 * account that exists (by code) is left as the owner has it, except that it gets a role added
 * since it was installed (the store boxes, ADR-014) when no other account already has that role.
 */
export async function installChart(tx: Tx, locations: LocationView[]): Promise<number> {
  const existing = await tx.glAccount.findMany({
    select: { id: true, code: true, systemRole: true },
  });
  const idByCode = new Map(existing.map((a) => [a.code, a.id]));
  const takenRoles = new Set(existing.flatMap((a) => (a.systemRole ? [a.systemRole] : [])));
  for (const def of DEFAULT_CHART) {
    const row = existing.find((a) => a.code === def.code);
    if (row && def.role && !row.systemRole && !takenRoles.has(def.role)) {
      await tx.glAccount.update({ where: { id: row.id }, data: { systemRole: def.role } });
      takenRoles.add(def.role);
    }
  }
  const allCodes = [...idByCode.keys(), ...DEFAULT_CHART.map((d) => d.code)];

  const rows = [];
  for (const def of DEFAULT_CHART) {
    if (idByCode.has(def.code)) continue;
    const id = uuidv7();
    const parentCode = parentCodeOf(def.code, allCodes);
    idByCode.set(def.code, id);
    rows.push({
      id,
      code: def.code,
      nameAr: def.nameAr,
      class: Number(def.code[0]),
      parentId: parentCode ? idByCode.get(parentCode)! : null,
      isPostable: !def.heading,
      currency: def.currency ?? null,
      kind: def.kind ?? 'GENERAL',
      systemRole: def.role ?? null,
      branch: def.branch ?? null,
    });
  }
  // One statement: a row may name a parent inserted by the same statement.
  if (rows.length) await tx.glAccount.createMany({ data: rows });
  return rows.length + (await ensureLocationAccounts(tx, locations));
}

/** One inventory account per location (1105xx), so the books show stock where it is. */
export async function ensureLocationAccounts(tx: Tx, locations: LocationView[]): Promise<number> {
  const parent = await tx.glAccount.findUnique({ where: { systemRole: 'INVENTORY_PARENT' } });
  if (!parent) return 0;
  const accounts = await tx.glAccount.findMany({
    where: { parentId: parent.id },
    select: { code: true, locationId: true },
  });
  const covered = new Set(accounts.map((a) => a.locationId));
  const used = new Set(accounts.map((a) => a.code));
  let created = 0;
  let next = 1;
  for (const location of locations) {
    if (covered.has(location.id)) continue;
    while (used.has(`${parent.code}${String(next).padStart(2, '0')}`)) next += 1;
    const code = `${parent.code}${String(next).padStart(2, '0')}`;
    used.add(code);
    await tx.glAccount.create({
      data: {
        code,
        nameAr: `مخزون ${location.nameAr}`,
        class: 1,
        parentId: parent.id,
        kind: 'INVENTORY',
        locationId: location.id,
        // Every location is in Syria today; the owner changes it on the account if not.
        branch: 'SY',
      },
    });
    created += 1;
  }
  return created;
}
