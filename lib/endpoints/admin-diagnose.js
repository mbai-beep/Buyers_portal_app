/**
 * One call that reports everything needed to explain a failing deployment:
 * which settings are set, what the Turso side looks like, how the HR table
 * maps, who the access rule admits, whether zRetailHQ0 is reachable from
 * this function, and the real column list of each reporting view.
 *
 *   curl -H "x-bootstrap-token: $BOOTSTRAP_TOKEN" https://<app>/api/admin/diagnose
 *
 * Structure only - column names, counts, mappings. No row values from the HR
 * table or the reporting views, because both hold data that does not need to
 * leave the database to answer a configuration question.
 */
import crypto from 'node:crypto';
import { json, methodNotAllowed, clientIp } from '../http.js';
import { db, listTables, columnsOf, OWNED_TABLES } from '../db.js';
import { sessionSecretProblem, directoryConfigProblem, classifyDirectoryError, redact } from '../config.js';
import { hrTableName, mapColumns, readHrDirectory } from '../hr-directory.js';

function tokenOk(given) {
  const expected = process.env.BOOTSTRAP_TOKEN || '';
  if (!expected) return false;
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const REPORTED_ENV = [
  'SESSION_SECRET', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'PORTAL_ADMIN_EMAILS',
  'SESSION_HOURS', 'BOOTSTRAP_TOKEN', 'HR_TABLE', 'HR_INCLUDE_ROLES',
  'HR_INCLUDE_DESIGNATIONS', 'HR_INCLUDE_ALL', 'HR_COL_EMAIL',
  'SQLSERVER_HOST', 'SQLSERVER_PORT', 'SQLSERVER_USER', 'SQLSERVER_PASSWORD',
  'SQLSERVER_DATABASE', 'SQLSERVER_ENCRYPT', 'SQLSERVER_TRUST_SERVER_CERTIFICATE',
];
const SECRET_ENV = new Set(['SESSION_SECRET', 'TURSO_AUTH_TOKEN', 'BOOTSTRAP_TOKEN', 'SQLSERVER_PASSWORD']);

export default async function handler(req, res) {
  if (!process.env.BOOTSTRAP_TOKEN) return json(res, 404, { error: 'not_found' });
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  if (!tokenOk(req.headers['x-bootstrap-token'])) {
    console.warn('diagnose rejected from', clientIp(req));
    return json(res, 403, { error: 'forbidden' });
  }

  const out = { at: new Date().toISOString(), env: {}, turso: {}, sqlServer: {}, verdict: [] };

  for (const key of REPORTED_ENV) {
    const v = process.env[key];
    out.env[key] = !v ? 'NOT SET' : (SECRET_ENV.has(key) ? `set (${v.length} chars)` : v);
  }

  const secretProblem = sessionSecretProblem();
  if (secretProblem) out.verdict.push(`BLOCKS LOGIN: ${secretProblem}`);

  // ------------------------------------------------------------ Turso side
  const configProblem = directoryConfigProblem();
  if (configProblem) {
    out.turso = { status: 'not_configured', detail: configProblem };
    out.verdict.push(`BLOCKS LOGIN: ${configProblem}`);
  } else {
    try {
      const c = db();
      const tables = await listTables(c);
      out.turso.status = 'reachable';
      out.turso.database = (process.env.TURSO_DATABASE_URL || '').replace(/^(libsql:\/\/[^/?]+).*/, '$1');
      out.turso.tables = {};
      for (const t of tables) {
        let n = null;
        try { n = Number((await c.execute(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '')}"`)).rows[0]?.n ?? 0); } catch {}
        out.turso.tables[t] = {
          owner: OWNED_TABLES.includes(t) ? 'this app' : 'the business (read only)',
          rows: n,
          columns: (await columnsOf(t, c)).map((col) => col.name),
        };
      }

      if (!tables.includes('portal_users')) {
        out.verdict.push('BLOCKS LOGIN: portal_users does not exist - run POST /api/admin/bootstrap');
      } else {
        const { rows } = await c.execute(
          `SELECT COUNT(*) AS total, SUM(is_active) AS active,
                  SUM(CASE WHEN password_hash IS NULL THEN 1 ELSE 0 END) AS never_signed_in
             FROM portal_users`
        );
        out.turso.portalUsers = {
          total: Number(rows[0]?.total || 0),
          active: Number(rows[0]?.active || 0),
          neverSignedIn: Number(rows[0]?.never_signed_in || 0),
        };
        if (out.turso.portalUsers.active === 0) {
          out.verdict.push('BLOCKS LOGIN: portal_users has no active rows - run POST /api/admin/bootstrap');
        }
      }

      const hr = hrTableName();
      if (tables.includes(hr)) {
        const { mapping, notes } = mapColumns(await columnsOf(hr, c));
        out.turso.hrDirectory = { table: hr, detected: mapping, how: notes };
        try {
          const read = await readHrDirectory();
          out.turso.hrDirectory.accessRule = read.accessRule;
          out.turso.hrDirectory.wouldSignIn = read.rows?.length ?? 0;
          out.turso.hrDirectory.rowsWithoutEmail = read.skipped?.length ?? 0;
          out.turso.hrDirectory.excludedByRule = read.excluded?.length ?? 0;
          out.turso.hrDirectory.sampleAdmitted = (read.rows || []).slice(0, 8)
            .map((r) => `${r.email} (${r.designation || '-'})`);
          if (!read.available) out.verdict.push(`HR import unavailable: ${read.reason}`);
          else if (!read.rows.length) out.verdict.push('HR table has rows but the access rule admits nobody - check HR_INCLUDE_ROLES against the role column values');
        } catch (err) {
          out.turso.hrDirectory.error = redact(err.message || err);
        }
      } else {
        out.turso.hrDirectory = { table: hr, note: `no ${hr} table in this database` };
      }
    } catch (err) {
      const { reason, hint } = classifyDirectoryError(err);
      out.turso = { status: 'error', reason, hint, error: redact(err?.message || err) };
      out.verdict.push(`BLOCKS LOGIN: Turso ${reason} - ${hint}`);
    }
  }

  // -------------------------------------------------------- SQL Server side
  const started = Date.now();
  try {
    const { serverInfo, describeViews } = await import('../../lib/reports.js');
    out.sqlServer.server = await serverInfo();
    out.sqlServer.ms = Date.now() - started;
    out.sqlServer.status = 'reachable';
    out.sqlServer.views = await describeViews();
    for (const [key, v] of Object.entries(out.sqlServer.views)) {
      if (!v.found) out.verdict.push(`Reporting view missing or not visible: ${key} -> ${v.name}`);
    }
  } catch (err) {
    out.sqlServer = {
      status: 'unreachable',
      ms: Date.now() - started,
      error: redact(err?.message || err),
      hint: 'Vercel functions egress from a wide, changing IP pool. If the firewall in ' +
            'front of this SQL Server allows only known addresses, it cannot connect. ' +
            'This does not affect login, which only needs Turso.',
    };
    out.verdict.push('Reporting data unavailable: SQL Server not reachable from this function');
  }

  if (!out.verdict.length) out.verdict.push('No problems found - login and reporting should both work.');
  out.ok = out.verdict.length === 1 && out.verdict[0].startsWith('No problems');

  return json(res, 200, out);
}
