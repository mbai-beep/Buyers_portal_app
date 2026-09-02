#!/usr/bin/env node
/**
 * Seeds the Turso employee directory.
 *
 * The names, emails and designations are read straight out of the SPA's own
 * TEAMS and V2 constants, so the directory matches what the portal already
 * shows rather than a second hand-typed list that drifts.
 *
 *   node scripts/seed-employees.mjs            # insert / update
 *   node scripts/seed-employees.mjs --dry-run  # show what it would do
 */
import { readFileSync } from 'node:fs';
import { loadEnv } from './env.mjs';
loadEnv();

const DRY = process.argv.includes('--dry-run');
const PORTAL = new URL('../assets/MB-Buyers-Portal.html', import.meta.url);

/** Pulls one top-level `const NAME = <literal>;` out of the SPA. */
function grabConst(src, name) {
  const at = src.indexOf(`const ${name} = `);
  if (at < 0) return null;
  const start = src.indexOf('=', at) + 1;
  let depth = 0, inString = null, i = start;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'") { inString = c; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ';' && depth === 0) break;
  }
  // The slice is a JSON-ish object literal from a file in this repo, not input.
  return Function(`"use strict";return (${src.slice(start, i)});`)();
}

function collect() {
  const src = readFileSync(PORTAL, 'utf8');
  const TEAMS = grabConst(src, 'TEAMS') || {};
  const V2 = grabConst(src, 'V2') || {};

  const byEmail = new Map();
  const conflicts = [];
  const reported = new Set();

  const add = (rec) => {
    const email = String(rec.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return;
    const existing = byEmail.get(email);
    if (existing) {
      if (existing.name !== rec.name) {
        // Two different people on one address is a data problem worth naming.
        const seen = `${email}|${rec.name}`;
        if (!reported.has(seen)) {
          reported.add(seen);
          conflicts.push({ email, kept: existing.name, ignored: rec.name });
        }
      }
      // The per-supplier contact cards carry fuller job titles than the desk
      // rosters ("Head of Buying & Merchandising" vs "Head of buying"), so the
      // more specific one wins.
      if ((rec.designation || '').length > (existing.designation || '').length) {
        existing.designation = rec.designation;
      }
      existing.department ||= rec.department;
      existing.desk ||= rec.desk;
      if (rec.role === 'admin') existing.role = 'admin';
      return;
    }
    byEmail.set(email, { ...rec, email });
  };

  // The desk rosters carry team structure.
  for (const [head, team] of Object.entries(TEAMS)) {
    for (const p of team.people || []) {
      add({ name: p.n, email: p.e, designation: p.r, department: head, desk: team.team, role: 'buyer' });
    }
  }
  // The per-supplier contact cards carry the full designations.
  for (const v of Object.values(V2)) {
    for (const p of v.team || []) {
      add({ name: p.name, email: p.email, designation: p.designation, department: null, desk: p.role || null, role: 'buyer' });
    }
  }
  // Whoever runs the portal.
  for (const email of String(process.env.PORTAL_ADMIN_EMAILS || '').split(',')) {
    const e = email.trim().toLowerCase();
    if (!e) continue;
    if (byEmail.has(e)) { byEmail.get(e).role = 'admin'; continue; }
    add({ name: 'Portal Administrator', email: e, designation: 'IT / Portal Administrator',
          department: 'IT', desk: 'Portal administration', role: 'admin' });
  }

  return { people: [...byEmail.values()], conflicts };
}

const { people, conflicts } = collect();

console.log(`Found ${people.length} employees in the portal source.`);
for (const c of conflicts) {
  console.warn(`  ! ${c.email} is shared by two names — keeping "${c.kept}", ignoring "${c.ignored}". ` +
               'Give them separate addresses in the portal source if both are real people.');
}

if (DRY) {
  for (const p of people) {
    console.log(`  ${p.email.padEnd(28)} ${String(p.name).padEnd(24)} ${p.designation || ''}${p.role === 'admin' ? '  [admin]' : ''}`);
  }
  console.log('\nDry run — nothing written.');
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
