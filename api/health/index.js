/**
 * Readiness, written to be self-diagnosing.
 *
 * Reports which settings are present, whether the employee directory answers,
 * whether the expected tables and columns are actually there, and how many
 * employees exist - so a failing login can be explained without guesswork.
 * Values are never echoed: only whether each is set, and its length.
 */
import { json } from '../../lib/http.js';
import { db } from '../../lib/db.js';
import {
  sessionSecretProblem, directoryConfigProblem, classifyDirectoryError, redact,
} from '../../lib/config.js';

const REQUIRED = ['SESSION_SECRET', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'];
const OPTIONAL = ['PORTAL_ADMIN_EMAILS', 'SESSION_HOURS', 'BOOTSTRAP_TOKEN',
                  'SQLSERVER_HOST', 'SQLSERVER_PORT', 'SQLSERVER_USER',
                  'SQLSERVER_PASSWORD', 'SQLSERVER_DATABASE'];

// The app's own sign-in table. The business's `employees` table is reported
// separately and never required to look like this.
const AUTH_TABLE = 'portal_users';
const EXPECTED_COLUMNS = [
  'id', 'name', 'email', 'designation', 'department', 'desk', 'role',
  'password_hash', 'must_change_password', 'is_active',
];

export default async function handler(_req, res) {
  const out = {
    ok: true,
    service: 'mbz-buyers-portal',
    at: new Date().toISOString(),
    problems: [],
    env: {},
    checks: {},
  };

  for (const key of [...REQUIRED, ...OPTIONAL]) {
    const v = process.env[key];
    out.env[key] = v ? `set (${v.length} chars)` : (REQUIRED.includes(key) ? 'MISSING' : 'not set');
  }

  // The database this deployment is actually pointed at, host only.
  const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || '';
  out.checks.directoryUrl = url
    ? (url.startsWith('file:') ? url : url.replace(/^(libsql:\/\/[^/?]+).*/, '$1'))
    : 'MISSING';

  const secretProblem = sessionSecretProblem();
  out.checks.sessionSecret = secretProblem ? { status: 'error', detail: secretProblem } : { status: 'ok' };
  if (secretProblem) out.problems.push(secretProblem);

  const configProblem = directoryConfigProblem();
  if (configProblem) {
    out.checks.turso = { status: 'error', reason: 'not_configured', detail: configProblem };
    out.problems.push(configProblem);
  } else {
    const started = Date.now();
    try {
      const client = db();

      const { rows: tables } = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );
      const tableNames = tables.map((r) => String(r.name));

      const check = { status: 'ok', ms: Date.now() - started, tables: tableNames };

      if (!tableNames.includes(AUTH_TABLE)) {
        check.status = 'error';
        check.reason = 'schema_missing';
        check.detail = `No ${AUTH_TABLE} table in this database. POST /api/admin/bootstrap with ` +
                       'BOOTSTRAP_TOKEN set, or check that the URL points at the right database.';
        out.problems.push(check.detail);
      } else {
        const { rows: cols } = await client.execute(`PRAGMA table_info(${AUTH_TABLE})`);
        const present = cols.map((c) => String(c.name));
        const missing = EXPECTED_COLUMNS.filter((c) => !present.includes(c));
        check.authTableColumns = present;
        if (missing.length) {
          check.status = 'error';
          check.reason = 'schema_mismatch';
          check.missingColumns = missing;
          check.detail = `The ${AUTH_TABLE} table is missing: ${missing.join(', ')}. ` +
                         'It was probably created by hand. Run the bootstrap endpoint to add them.';
          out.problems.push(check.detail);
        } else {
          const { rows } = await client.execute(
            'SELECT COUNT(*) AS total, SUM(is_active) AS active, ' +
            'SUM(CASE WHEN password_hash IS NULL THEN 1 ELSE 0 END) AS never_signed_in ' +
            `FROM ${AUTH_TABLE}`
          );
          check.employees = {
            total: Number(rows[0]?.total || 0),
            active: Number(rows[0]?.active || 0),
            neverSignedIn: Number(rows[0]?.never_signed_in || 0),
          };
          if (check.employees.active === 0) {
            check.status = 'error';
            check.reason = 'empty_directory';
            check.detail = `The ${AUTH_TABLE} table exists but holds no active rows. Run the bootstrap endpoint.`;
            out.problems.push(check.detail);
          }
        }
      }

      out.checks.turso = check;
    } catch (err) {
      const { reason, hint } = classifyDirectoryError(err);
      console.error(`health: directory failed [${reason}]`, redact(err?.stack || err?.message || err));
      out.checks.turso = {
        status: 'error', reason, detail: hint,
        ms: Date.now() - started,
        error: redact(err?.message || err),
      };
      out.problems.push(`${reason}: ${hint}`);
    }
  }

  out.checks.bootstrapEndpoint = process.env.BOOTSTRAP_TOKEN
    ? 'open (remove BOOTSTRAP_TOKEN once the directory is seeded)'
    : 'closed';

  out.ok = out.problems.length === 0;
  if (out.ok) delete out.problems;

  return json(res, out.ok ? 200 : 503, out);
}
