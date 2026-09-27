// Creates a login. There is no self-registration (docs/security.md).
//
//   pnpm user:create --email ahmad@example.com --name "أحمد" --roles warehouse_keeper
//
// A strong password is generated and printed ONCE. Give it to the person privately.
// Roles: owner, manager, inventory_manager, warehouse_keeper, store_staff, accountant.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createAuthService } from '../src/modules/auth/auth.service.js';
import { createDb } from '../src/shared/db.js';

const envFile = join(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    roles: { type: 'string' },
  },
});

if (!values.email || !values.name || !values.roles) {
  console.error('Usage: pnpm user:create --email <email> --name "<الاسم>" --roles <role[,role]>');
  process.exit(1);
}

// 18 random bytes → 24 base64url characters: well past the 12-character minimum.
const password = randomBytes(18).toString('base64url');
const db = createDb();

try {
  const user = await createAuthService(db).createUser({
    email: values.email,
    nameAr: values.name,
    roles: values.roles.split(',').map((r) => r.trim()),
    password,
  });
  console.log(`Created ${user.email} (${user.roles.join(', ')})`);
  console.log(`Password (shown once): ${password}`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
