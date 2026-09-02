#!/usr/bin/env node
/** Creates the employee directory tables. Safe to re-run. */
import { loadEnv } from './env.mjs';
loadEnv();

const { initSchema, db } = await import('../lib/db.js');

const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set. Put it in .env.local (file:local.db works for a local run).');
  process.exit(1);
}

await initSchema();
const { rows } = await db().execute(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
);
console.log(`Schema ready on ${url.replace(/(authToken=)[^&]+/, '$1***')}`);
console.log('Tables:', rows.map((r) => r.name).join(', '));
