#!/usr/bin/env node
/**
 * Proves the SQL Server credentials work from wherever you run this, and
 * prints enough of zRetailHQ0's shape to write the reporting queries against.
 *
 *   node scripts/check-sqlserver.mjs                 # connect + list tables
 *   node scripts/check-sqlserver.mjs --dump          # full column dump to docs/
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadEnv } from './env.mjs';
loadEnv();

const DUMP = process.argv.includes('--dump');
const { query, pool } = await import('../lib/sql.js');

try {
  const [meta] = await query(
    `SELECT DB_NAME() AS db, SYSDATETIME() AS at, SUSER_SNAME() AS login,
            LEFT(@@VERSION, 120) AS version`
  );
  console.log(`Connected to ${meta.db} as ${meta.login}`);
  console.log(`  server time ${meta.at}`);
  console.log(`  ${meta.version.replace(/\s+/g, ' ')}`);

  const tables = await query(
    `SELECT s.name AS [schema], t.name AS [table],
            SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows ELSE 0 END) AS [rows]
       FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id = t.schema_id
       LEFT JOIN sys.partitions p ON p.object_id = t.object_id
      GROUP BY s.name, t.name
      ORDER BY [rows] DESC`
  );
  console.log(`\n${tables.length} tables. Largest 40:`);
  for (const t of tables.slice(0, 40)) {
    console.log(`  ${String(t.rows).padStart(12)}  ${t.schema}.${t.table}`);
  }

  if (DUMP) {
    const columns = await query(
      `SELECT TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION, COLUMN_NAME,
              DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION,
              NUMERIC_SCALE, IS_NULLABLE
         FROM INFORMATION_SCHEMA.COLUMNS
        ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`
    );
    const views = await query(
      `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS
        ORDER BY TABLE_SCHEMA, TABLE_NAME`
    );
    const procs = await query(
      `SELECT SPECIFIC_SCHEMA, SPECIFIC_NAME, ROUTINE_TYPE
         FROM INFORMATION_SCHEMA.ROUTINES ORDER BY SPECIFIC_SCHEMA, SPECIFIC_NAME`
    );
    mkdirSync('docs', { recursive: true });
    const out = 'docs/schema-dump.json';
    writeFileSync(out, JSON.stringify({ meta, tables, columns, views, procs }, null, 1));
    console.log(`\nWrote ${out} (${tables.length} tables, ${columns.length} columns, ` +
                `${views.length} views, ${procs.length} routines).`);
  }
} catch (err) {
  console.error('\nCould not reach SQL Server.');
  console.error(`  ${err.message}`);
  console.error('\nChecks: SQLSERVER_* values in .env.local, the server firewall for this IP,');
  console.error('and whether TLS is required (SQLSERVER_ENCRYPT).');
  process.exitCode = 1;
} finally {
  try { (await pool()).close(); } catch { /* nothing to close */ }
}
