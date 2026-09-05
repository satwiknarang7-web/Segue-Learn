process.env.EDUPLATFORM_DB_MEMORY = 'true';
delete process.env.DATABASE_URL;

const { initialiseDatabase, closeDatabase, query } = await import('../../src/db/index.js');
const { runMigrations } = await import('../../src/db/migrate.js');

/**
 * A migrated, empty database for one test file.
 *
 * PGlite in memory, so every file starts from nothing, nothing is left behind,
 * and the tests exercise the same SQL Supabase will run.
 */
export async function freshDatabase() {
  await initialiseDatabase();
  await runMigrations({ log: () => {} });
  return { query, close: closeDatabase };
}

/** Empties every table between tests without re-running the migrations. */
export async function truncateAll() {
  await query(`
    truncate universities, users, classrooms, classroom_members, content_items,
             calendar_events, announcements, discussion_threads, discussion_posts,
             quizzes, quiz_attempts, grade_items, grades,
             conversations, conversation_members, messages
    restart identity cascade
  `);
}
