import { neonConfig } from '@neondatabase/serverless';
import { PrismaClient, type Prisma } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;
/** Anything that can run a query: the client itself or an open transaction. */
export type Queryable = Db | Tx;

// Neon's driver speaks the Postgres protocol over a WebSocket on port 443 (ADR-006). The
// development network blocks port 5432, and 443 is open everywhere HTTPS is. Node 22 ships a
// standard WebSocket, so no extra package is needed.
neonConfig.webSocketConstructor = WebSocket;

export function createDb(url: string | undefined = process.env.DATABASE_URL): Db {
  if (!url) throw new Error('DATABASE_URL is not set — see .env.example');
  return new PrismaClient({
    adapter: new PrismaNeon({ connectionString: withoutPrismaParams(url) }),
  });
}

/** pgbouncer / connect_timeout / pool_timeout are Prisma engine parameters, not libpq ones. */
export function withoutPrismaParams(url: string): string {
  const parsed = new URL(url);
  for (const key of ['pgbouncer', 'connect_timeout', 'pool_timeout', 'connection_limit']) {
    parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

// Neon is reached over the network, so a transaction gets more room than Prisma's 5s default.
// Transactions still contain only database work — no HTTP, no printing (docs/database.md).
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

export async function inTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(fn, TX_OPTIONS);
}
