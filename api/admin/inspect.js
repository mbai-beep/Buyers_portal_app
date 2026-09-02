/**
 * Reports the shape of the database this deployment is pointed at, so a
 * mismatch can be diagnosed without anyone having to describe their schema
 * from memory.
 *
 *   curl -H "x-bootstrap-token: $BOOTSTRAP_TOKEN" https://<app>/api/admin/inspect
 *
 * Column names and row counts only - never row values. The HR table holds
 * personal data (names, mobile numbers) and none of it needs to leave the
 * database to answer "which column is the email address?".
 */
import crypto from 'node:crypto';
import { json, methodNotAllowed, clientIp } from '../../lib/http.js';
import { db, listTables, columnsOf, OWNED_TABLES } from '../../lib/db.js';
import { redact } from '../../lib/config.js';
import { hrTableName, mapColumns } from '../../lib/hr-directory.js';

function tokenOk(given) {
  const expected = process.env.BOOTSTRAP_TOKEN || '';
  if (!expected) return false;
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (!process.env.BOOTSTRAP_TOKEN) return json(res, 404, { error: 'not_found' });
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  if (!tokenOk(req.headers['x-bootstrap-token'])) {
    console.warn('inspect rejected from', clientIp(req));
    return json(res, 403, { error: 'forbidden' });
  }

  try {
    const c = db();
    const tables = await listTables(c);
    const out = { ok: true, tables: {}, ownedByApp: OWNED_TABLES };

    for (const table of tables) {
      const cols = await columnsOf(table, c);
      let count = null;
      try {
        const { rows } = await c.execute(`SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '')}"`);
        count = Number(rows[0]?.n || 0);
      } catch { /* a view or something unreadable */ }
      out.tables[table] = {
        owner: OWNED_TABLES.includes(table) ? 'this app' : 'the business (read only)',
        rows: count,
        columns: cols.map((col) => `${col.name}${col.type ? ` ${col.type}` : ''}${col.notNull ? ' NOT NULL' : ''}`),
      };
    }

    const hr = hrTableName();
    if (tables.includes(hr)) {
      const { mapping, notes } = mapColumns(await columnsOf(hr, c));
      out.hrDirectory = {
        table: hr,
        detected: mapping,
        how: notes,
        usable: Boolean(mapping.email),
        note: mapping.email
          ? 'An email column was found, so sign-ins can be imported from this table.'
          : 'No email column found. Sign-in is by email address, so either add one to ' +
            'this table, or set HR_COL_EMAIL to the column that holds it.',
      };
    } else {
      out.hrDirectory = { table: hr, usable: false, note: `No ${hr} table in this database.` };
    }

    return json(res, 200, out);
  } catch (err) {
    console.error('inspect failed', redact(err?.stack || err));
    return json(res, 500, { error: 'inspect_failed', message: redact(err?.message || err) });
  }
}
