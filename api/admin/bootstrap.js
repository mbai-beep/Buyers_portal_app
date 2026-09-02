/**
 * One-time setup, run from inside the deployment.
 *
 * Turso is only reachable from a host with open egress, so the schema and the
 * roster are installed by calling this once after the first deploy rather than
 * from a laptop:
 *
 *   curl -X POST https://<app>/api/admin/bootstrap \
 *        -H "x-bootstrap-token: $BOOTSTRAP_TOKEN"
 *
 * It only exists while BOOTSTRAP_TOKEN is set - delete that variable in Vercel
 * once the directory is seeded and this endpoint returns 404 for everyone.
 * It never touches an existing password: upsert leaves password_hash alone.
 */
import crypto from 'node:crypto';
import { json, methodNotAllowed, clientIp } from '../../lib/http.js';
import { initSchema } from '../../lib/db.js';
import { upsertEmployee, listEmployees } from '../../lib/employees.js';
import { readRoster } from '../../lib/roster.js';

function tokenOk(given) {
  const expected = process.env.BOOTSTRAP_TOKEN || '';
  if (!expected) return false;
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  // With no token configured the endpoint does not exist at all.
  if (!process.env.BOOTSTRAP_TOKEN) return json(res, 404, { error: 'not_found' });
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  if (!tokenOk(req.headers['x-bootstrap-token'])) {
    console.warn('bootstrap rejected from', clientIp(req));
    return json(res, 403, { error: 'forbidden' });
  }

  try {
    await initSchema();

    const { people, conflicts } = readRoster();
    const seeded = [];
    for (const p of people) {
      await upsertEmployee(p);
      seeded.push(p.email);
    }

    const directory = await listEmployees();
    return json(res, 200, {
      ok: true,
      schema: 'ready',
      seeded: seeded.length,
      activeEmployees: directory.length,
      conflicts,
      firstPassword: 'MBZ<their email address>',
      next: 'Remove BOOTSTRAP_TOKEN from the environment to close this endpoint.',
      employees: directory.map((e) => ({ name: e.name, email: e.email, designation: e.designation })),
    });
  } catch (err) {
    console.error('bootstrap failed', err);
    return json(res, 500, { error: 'bootstrap_failed', message: String(err.message || err) });
  }
}
