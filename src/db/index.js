import { config } from '../config.js';

/**
 * The one way anything in this application talks to Postgres.
 *
 * Two drivers sit behind an identical surface. With DATABASE_URL set it is
 * node-postgres against a real server (Supabase in production). Without it,
 * PGlite runs Postgres in this process against files under data/pgdata, so a
 * fresh clone starts with nothing to install and no container to run.
 *
 * Both are genuinely Postgres and both run the same migrations, so a query
 * that works in development works in production. The difference is capacity,
 * not dialect: PGlite is one connection in one process and is for development
 * and tests only.
 *
 * Everything is parameterised with $1, $2 -- which both drivers speak -- and
 * this module never interpolates a value into SQL.
 */

let driver = null;

async function createEmbeddedDriver() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');

  // PGlite creates its own directory but not the parents, and on a fresh
  // clone data/ does not exist yet. A null path means in-memory, which needs
  // no directory at all.
  if (config.database.embeddedPath) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(path.dirname(config.database.embeddedPath), { recursive: true });
  }

  // PGlite overloads its constructor: (dataDir, options) or (options). Passing
  // an explicit undefined dataDir takes the first form and loses the options,
  // extensions and all, so in-memory mode has to omit the argument entirely.
  const options = { extensions: { citext, pgcrypto } };
  const pglite = config.database.embeddedPath
    ? new PGlite(config.database.embeddedPath, options)
    : new PGlite(options);
  await pglite.waitReady;

  return {
    kind: 'pglite',
    async query(text, params = []) {
      const result = await pglite.query(text, params);
      return { rows: result.rows ?? [], rowCount: result.affectedRows ?? result.rows?.length ?? 0 };
    },
    async exec(text) {
      await pglite.exec(text);
    },
    async transaction(work) {
      return pglite.transaction(async (tx) =>
        work({
          async query(text, params = []) {
            const result = await tx.query(text, params);
            return {
              rows: result.rows ?? [],
              rowCount: result.affectedRows ?? result.rows?.length ?? 0,
            };
          },
        }),
      );
    },
    async close() {
      await pglite.close();
    },
  };
}

async function createPostgresDriver() {
  const { default: pg } = await import('pg');

  const pool = new pg.Pool({
    connectionString: config.database.url,
    // Supabase terminates TLS with a certificate this pool has no root for;
    // the connection is still encrypted, which is what matters here.
    ssl: /localhost|127\.0\.0\.1/.test(config.database.url)
      ? false
      : { rejectUnauthorized: false },
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // An idle client dying (a Supabase restart, a network blip) must not take
  // the process with it; the pool replaces it on the next checkout.
  pool.on('error', (error) => {
    console.error('[db] idle client error:', error.message);
  });

  return {
    kind: 'postgres',
    async query(text, params = []) {
      const result = await pool.query(text, params);
      return { rows: result.rows, rowCount: result.rowCount };
    },
    async exec(text) {
      await pool.query(text);
    },
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await work({
          async query(text, params = []) {
            const r = await client.query(text, params);
            return { rows: r.rows, rowCount: r.rowCount };
          },
        });
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** Opens the database. Must finish before the server accepts traffic. */
export async function initialiseDatabase() {
  if (driver) return driver;
  driver = config.database.embedded
    ? await createEmbeddedDriver()
    : await createPostgresDriver();
  return driver;
}

function active() {
  if (!driver) {
    throw new Error('The database was used before initialiseDatabase() finished.');
  }
  return driver;
}

/** Runs a parameterised statement and returns { rows, rowCount }. */
export function query(text, params) {
  return active().query(text, params);
}

/** Runs one or more statements with no parameters. Used by the migrator. */
export function exec(text) {
  return active().exec(text);
}

/**
 * Runs `work` inside a transaction, committing on return and rolling back on
 * throw. `work` is handed a `tx` whose .query must be used for every statement
 * that belongs to the transaction -- the module-level query() checks out a
 * different connection and would not be part of it.
 */
export function transaction(work) {
  return active().transaction(work);
}

/** First row or null, for the many lookups that expect at most one. */
export async function queryOne(text, params) {
  const { rows } = await query(text, params);
  return rows[0] ?? null;
}

export const databaseBackend = () => (config.database.embedded ? 'pglite' : 'postgres');

export async function closeDatabase() {
  if (!driver) return;
  await driver.close();
  driver = null;
}
