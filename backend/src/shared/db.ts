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
    adapter: new PrismaNeon({
      connectionString: withoutPrismaParams(url),
      // A WebSocket that dies silently (network drop, Neon restart) must fail a request within
      // seconds instead of hanging it: the app retries a failed request, never a hung one.
      connectionTimeoutMillis: 15_000,
      idleTimeoutMillis: 30_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
      max: 10,
    }),
  });
}

/** Resolves when the database answers within `ms`; rejects otherwise. */
export async function pingDb(db: Db, ms = 5_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`database did not answer within ${ms} ms`)), ms);
  });
  try {
    await Promise.race([db.$queryRaw`select 1`, timeout]);
  } finally {
    clearTimeout(timer);
  }
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
