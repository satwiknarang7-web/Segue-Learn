import fs from 'node:fs';
import http from 'node:http';

import { handleRequest } from './app.js';
import { config, isHostedDeployment, resolveBaseUrl, usesHttps } from './config.js';
import { closeDatabase, databaseBackend, initialiseDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { universityRepository } from './repositories/universityRepository.js';
import { accountService } from './services/accountService.js';

fs.mkdirSync(config.dataDir, { recursive: true });

// The database has to be open and migrated before the first request arrives.
try {
  await initialiseDatabase();
  await runMigrations();
} catch (error) {
  console.error('');
  console.error('  Could not start with the configured database.');
  console.error(`  ${error.message}`);

  // Name the actual remedy rather than repeating generic settings advice.
  if (/ENOTFOUND|ECONNREFUSED|timeout/i.test(error.message)) {
    console.error('');
    console.error('  Nothing answered at DATABASE_URL. Check the host and port, and that the');
    console.error('  database accepts connections from here.');
  } else if (/password|authentication|SASL/i.test(error.message)) {
    console.error('');
    console.error('  The database refused those credentials. DATABASE_URL must carry the');
    console.error('  password for the connection string, not the anon or service_role key.');
  } else {
    console.error('  Unset DATABASE_URL to fall back to the embedded database for development.');
  }

  console.error('');
  process.exit(1);
}

const universities = await universityRepository.list();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error('[fatal] unhandled request failure', error);
    if (!res.writableEnded) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"Something went wrong on the server."}');
    }
  });
});

server.listen(config.port, config.host, () => {
  console.log('');
  console.log('  EduPlatform is running');
  console.log(
    databaseBackend() === 'postgres'
      ? '  Database:   Postgres (DATABASE_URL)'
      : `  Database:   embedded Postgres in ${config.database.embeddedPath}`,
  );
  console.log(`  Address:    ${resolveBaseUrl()}`);
  console.log('');

  // Without a university, no signup can succeed, because an address's domain
  // is what decides which ecosystem an account belongs to.
  if (universities.length === 0) {
    console.warn('  ! No universities exist yet, so nobody can sign up.');
    console.warn('      Add one with:');
    console.warn('      npm run university -- --name "Your University" \\');
    console.warn('        --slug yours --domain yours.edu --faculty-code STAFF-2026');
    console.log('');
  } else {
    console.log(
      `  Universities: ${universities.map((u) => `${u.name} (@${u.emailDomain})`).join(', ')}`,
    );
    console.log('');
  }

  // On a hosting platform the defaults that make local use easy become traps.
  if (isHostedDeployment()) {
    const warnings = [];

    if (databaseBackend() !== 'postgres') {
      warnings.push([
        'The embedded database is in use on a hosted container.',
        'Every redeploy or restart wipes accounts, classrooms and grades.',
        'Set DATABASE_URL to your Supabase connection string.',
      ]);
    }

    if (!accountService.describeSecrets().sessionSecretFromEnvironment) {
      warnings.push([
        'EDUPLATFORM_SESSION_SECRET is not set.',
        'A new signing key is generated on every restart, which signs everybody out.',
        'Set it to a long random string.',
      ]);
    }

    if (!usesHttps()) {
      warnings.push([
        'This deployment is not serving over HTTPS.',
        'Passwords and one-time codes would cross the network in the clear.',
      ]);
    }

    for (const [headline, ...detail] of warnings) {
      console.warn(`  ! ${headline}`);
      for (const line of detail) console.warn(`      ${line}`);
    }
    if (warnings.length) console.log('');
  }
});

const shutdown = (signal) => {
  console.log(`\n[${signal}] shutting down`);
  server.close(async () => {
    await closeDatabase().catch(() => {});
    process.exit(0);
  });
  // Do not hang forever on keep-alive connections.
  setTimeout(() => process.exit(0), 3_000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
