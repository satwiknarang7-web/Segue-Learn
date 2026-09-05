import { closeDatabase, databaseBackend, initialiseDatabase } from './index.js';
import { runMigrations } from './migrate.js';

/** `npm run migrate` -- brings the configured database up to date and exits. */

await initialiseDatabase();
console.log(`[db] backend: ${databaseBackend()}`);

try {
  const { applied, skipped } = await runMigrations();
  console.log(
    applied.length === 0
      ? `[db] already up to date (${skipped} migration${skipped === 1 ? '' : 's'})`
      : `[db] applied ${applied.length} migration${applied.length === 1 ? '' : 's'}`,
  );
} catch (error) {
  console.error(`[db] ${error.message}`);
  await closeDatabase();
  process.exit(1);
}

await closeDatabase();
