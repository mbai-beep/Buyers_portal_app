#!/usr/bin/env node
/**
 * Seeds the Turso employee directory from the SPA's own TEAMS and V2 constants
 * (see lib/roster.js), so the directory matches what the portal displays.
 *
 *   node scripts/seed-employees.mjs            # insert / update
 *   node scripts/seed-employees.mjs --dry-run  # show what it would do
 *
 * Needs a host that can reach Turso. If your network cannot, deploy first and
 * call POST /api/admin/bootstrap once instead - same roster, same result.
 */
import { loadEnv } from './env.mjs';
loadEnv();

const DRY = process.argv.includes('--dry-run');

const { readRoster } = await import('../lib/roster.js');
const { people, conflicts } = readRoster();

console.log(`Found ${people.length} employees in the portal source.`);
for (const c of conflicts) {
  console.warn(`  ! ${c.email} is shared by two names \u2014 keeping "${c.kept}", ignoring "${c.ignored}". ` +
               'Give them separate addresses in the portal source if both are real people.');
}

if (DRY) {
  for (const p of people) {
    console.log(`  ${p.email.padEnd(28)} ${String(p.name).padEnd(24)} ${p.designation || ''}` +
                `${p.role === 'admin' ? '  [admin]' : ''}`);
  }
  console.log('\nDry run \u2014 nothing written.');
  process.exit(0);
}

if (!process.env.TURSO_DATABASE_URL && !process.env.LIBSQL_URL) {
  console.error('TURSO_DATABASE_URL is not set.');
  process.exit(1);
}

const { initSchema } = await import('../lib/db.js');
const { upsertEmployee, listEmployees } = await import('../lib/employees.js');

await initSchema();
for (const p of people) {
  await upsertEmployee(p);
  console.log(`  upserted ${p.email}`);
}

const all = await listEmployees();
console.log(`\nDirectory now holds ${all.length} active employees.`);
console.log('Each signs in the first time with:  MBZ<their email address>');
console.log('e.g.  chetna@mbindia.net  ->  MBZchetna@mbindia.net');
