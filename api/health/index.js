import { json } from '../../lib/http.js';
import { db } from '../../lib/db.js';

export default async function handler(_req, res) {
  const out = { ok: true, service: 'mbz-buyers-portal', at: new Date().toISOString(), checks: {} };

  out.checks.sessionSecret = process.env.SESSION_SECRET
    ? (process.env.SESSION_SECRET.length >= 32 ? 'ok' : 'too_short')
    : 'missing';

  try {
    const { rows } = await db().execute('SELECT COUNT(*) AS n FROM employees WHERE is_active = 1');
    out.checks.turso = { status: 'ok', activeEmployees: Number(rows[0]?.n || 0) };
  } catch (err) {
    out.ok = false;
    out.checks.turso = { status: 'error', message: String(err.message || err) };
  }

  res.statusCode = out.ok ? 200 : 503;
  return json(res, res.statusCode, out);
}
