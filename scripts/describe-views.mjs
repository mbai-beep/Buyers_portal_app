#!/usr/bin/env node
/**
 * Prints the real column list of the three reporting views, from anywhere
 * that can reach zRetailHQ0. Use this when the sandbox or Vercel cannot.
 *
 *   npm run sql:views
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadEnv } from './env.mjs';
loadEnv();

const { serverInfo, describeViews } = await import('../lib/reports.js');
const { pool } = await import('../lib/sql.js');

try {
  const info = await serverInfo();
  console.log(`Connected to ${info.database} as ${info.login} (${info.serverTime})`);

  const views = await describeViews();
  for (const [key, v] of Object.entries(views)) {
    console.log(`\n${'='.repeat(78)}\n${key}  ->  ${v.name}\n  ${v.what}\n${'='.repeat(78)}`);
    if (!v.found) {
      console.log(`  NOT FOUND${v.error ? `: ${v.error}` : ''}`);
      if (v.similarlyNamed?.length) console.log(`  similarly named: ${v.similarlyNamed.join(', ')}`);
      continue;
    }
    console.log(`  rows: ${v.rowCount}   columns: ${v.columnCount}`);
    for (const c of v.columns) console.log(`    ${c}`);
  }

  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/schema-dump.json', JSON.stringify({ info, views }, null, 1));
  console.log('\nWrote docs/schema-dump.json (gitignored) - send it over.');
} catch (err) {
  console.error(`\nCould not reach SQL Server: ${err.message}`);
  process.exitCode = 1;
} finally {
  try { (await pool()).close(); } catch {}
}
