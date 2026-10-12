import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../shared/permissions.js';
import { createTestContext, withoutPermission, type World } from '../../../test/helpers.js';

const t = createTestContext();
const locations = t.services.locations;
let w: World;

beforeEach(async () => {
  w = await t.reset();
});
afterAll(async () => t.close());

describe('renaming locations', () => {
  it('changes only the names; the code and kind stay', async () => {
    const renamed = await locations.updateLocation(
      w.wh1.id,
      { nameAr: 'مستودع حلب', nameEn: 'Aleppo warehouse' },
      w.owner,
    );
    expect(renamed).toMatchObject({
      code: w.wh1.code,
      kind: w.wh1.kind,
      nameAr: 'مستودع حلب',
      nameEn: 'Aleppo warehouse',
    });
    expect((await locations.getLocation(w.wh1.id, w.owner)).nameAr).toBe('مستودع حلب');
  });

  it('refuses an empty name, and anyone without admin.locations.write', async () => {
    await expect(
      locations.updateLocation(w.wh1.id, { nameAr: ' ' }, w.owner),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      locations.updateLocation(
        w.wh1.id,
        { nameAr: 'x' },
        withoutPermission(w.owner, PERMISSIONS.admin.locations),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
