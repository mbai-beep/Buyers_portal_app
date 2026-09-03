import { json } from '../http.js';
import { getSession } from '../session.js';
import { query } from '../sql.js';

/** Signed-in-only: proves the Vercel function can actually reach zRetailHQ0. */
export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) return json(res, 401, { error: 'not_signed_in' });

  const started = Date.now();
  try {
    const rows = await query(
      `SELECT DB_NAME() AS [database], @@VERSION AS [version],
              SYSDATETIME() AS [serverTime],
              (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES) AS [tableCount]`
    );
    return json(res, 200, { ok: true, ms: Date.now() - started, server: rows[0] });
  } catch (err) {
    console.error('sql health failed', err);
    return json(res, 503, {
      ok: false, ms: Date.now() - started,
      error: 'sql_unreachable',
      message: String(err.message || err),
      hint: 'Check SQLSERVER_* env vars and that the SQL Server firewall allows Vercel egress IPs on this port.',
    });
  }
}
