import fs from 'node:fs/promises';
import path from 'node:path';

import { config } from '../config.js';
import { exec, query } from './index.js';

/**
 * Applies every .sql file in supabase/migrations that has not run yet, in
 * filename order, and records each one so it never runs twice.
 *
 * The same files are what you paste into the Supabase SQL editor, so there is
 * one description of the schema rather than two that drift.
 *
 * Each file is applied as a single statement batch, which Postgres wraps in
 * one implicit transaction: a migration that fails half way leaves nothing
 * behind, and the ledger row is only written once it has committed.
 */

const LEDGER = `
  create table if not exists public.schema_migrations (
    name        text        primary key,
    applied_at  timestamptz not null default now()
  );
`;

export async function runMigrations({ log = console.log } = {}) {
  await exec(LEDGER);

  const { rows } = await query('select name from public.schema_migrations');
  const applied = new Set(rows.map((row) => row.name));

  let files;
  try {
    files = (await fs.readdir(config.migrationsDir))
      .filter((name) => name.endsWith('.sql'))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return { applied: [], skipped: 0 };
    throw error;
  }

  const pending = files.filter((name) => !applied.has(name));
  if (pending.length === 0) {
    return { applied: [], skipped: files.length };
  }

  for (const name of pending) {
    const sql = await fs.readFile(path.join(config.migrationsDir, name), 'utf8');
    try {
      await exec(sql);
    } catch (error) {
      throw new Error(`Migration ${name} failed: ${error.message}`);
    }
    await query('insert into public.schema_migrations (name) values ($1)', [name]);
    log(`[db] applied ${name}`);
  }

  return { applied: pending, skipped: files.length - pending.length };
}
