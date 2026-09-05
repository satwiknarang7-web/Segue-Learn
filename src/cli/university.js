import { closeDatabase, initialiseDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { universityRepository } from '../repositories/universityRepository.js';

/**
 * Adds a university, or lists the ones that exist.
 *
 * Universities are deliberately not self-service: the email domain is what
 * decides who may create an account, so handing that out through a web form
 * would let anyone claim an institution.
 *
 *   npm run university -- --list
 *   npm run university -- --name "Test University" --slug test --domain test.edu \
 *     --faculty-code STAFF-2026
 */

function parseArguments(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

const args = parseArguments(process.argv.slice(2));

await initialiseDatabase();
await runMigrations({ log: () => {} });

try {
  if (args.list) {
    const all = await universityRepository.list();
    if (all.length === 0) {
      console.log('No universities yet.');
    } else {
      for (const uni of all) {
        const code = uni.facultySignupCode ? `staff code: ${uni.facultySignupCode}` : 'no staff code';
        console.log(`${uni.name}\n  slug: ${uni.slug}\n  domain: @${uni.emailDomain}\n  ${code}\n`);
      }
    }
  } else {
    const missing = ['name', 'slug', 'domain'].filter((key) => typeof args[key] !== 'string');
    if (missing.length > 0) {
      console.error(`Missing --${missing.join(', --')}`);
      console.error('');
      console.error('  npm run university -- --name "Test University" --slug test \\');
      console.error('    --domain test.edu --faculty-code STAFF-2026');
      console.error('  npm run university -- --list');
      process.exitCode = 1;
    } else {
      const domain = args.domain.replace(/^@/, '').trim().toLowerCase();

      const clash = await universityRepository.findByEmailDomain(domain);
      if (clash) {
        console.error(`@${domain} already belongs to ${clash.name}.`);
        process.exitCode = 1;
      } else {
        const created = await universityRepository.insert({
          name: args.name,
          slug: String(args.slug).trim().toLowerCase(),
          emailDomain: domain,
          facultySignupCode:
            typeof args['faculty-code'] === 'string' ? args['faculty-code'].trim() : null,
        });

        console.log(`Added ${created.name}.`);
        console.log(`  Anyone with an @${created.emailDomain} address can now sign up.`);
        console.log(
          created.facultySignupCode
            ? `  Staff code for teacher accounts: ${created.facultySignupCode}`
            : '  No staff code set, so every account will be a student until an admin promotes one.',
        );
      }
    }
  }
} finally {
  await closeDatabase();
}
