import type { Db } from './shared/db.js';
import type { PhotoStorage } from './shared/storage.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { createCatalogueService } from './modules/catalogue/catalogue.service.js';
import { createPhotoService } from './modules/catalogue/photo.service.js';
import { createLocationsService } from './modules/locations/locations.service.js';
import { createInventoryService } from './modules/inventory/inventory.service.js';
import { createScanSessionService } from './modules/inventory/scan-session.service.js';
import { createStocktakeService } from './modules/inventory/stocktake.service.js';

/** Composition root: the only place modules are wired together. No DI container needed. */
export function createServices(db: Db, options: { storage?: PhotoStorage | null } = {}) {
  const catalogue = createCatalogueService(db);
  const locations = createLocationsService(db);
  const ledgerDeps = { catalogue, locations };

  return {
    auth: createAuthService(db),
    catalogue,
    photos: createPhotoService(db, options.storage ?? null),
    locations,
    inventory: createInventoryService(db, ledgerDeps),
    scanSessions: createScanSessionService(db, ledgerDeps),
    stocktakes: createStocktakeService(db, ledgerDeps),
  };
}

export type Services = ReturnType<typeof createServices>;
