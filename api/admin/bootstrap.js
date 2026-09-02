/**
 * One-time setup, run from inside the deployment.
 *
 * Creates this app's own tables (portal_users, login_audit) and fills them
 * from the business's employee table when that table carries email
 * addresses, or from the roster in the SPA when it does not. The employee
 * table itself is only ever read.
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
import { readHrDirectory } from '../../lib/hr-directory.js';

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
    // Retrofits a directory created by hand or by an older version, rather
    // than silently leaving it short of columns the app needs.
    const migrations = await initSchema();

    // The business's own employee table is the better source of truth when it
    // carries email addresses. The roster baked into the SPA is the fallback.
    const hr = await readHrDirectory();
    let source, people, conflicts = [], sourceNote;

    if (hr.available && hr.rows.length) {
      source = `${hr.table} (your employee table)`;
      people = hr.rows;
      sourceNote = `Read ${hr.total} rows from ${hr.table}; ${hr.rows.length} were given a sign-in.`;
    } else {
      const roster = readRoster();
      people = roster.people;
      conflicts = roster.conflicts;
      source = 'the portal source (TEAMS / V2)';
      sourceNote = hr.reason === 'no_email_column'
        ? `${hr.table} has no email column, so sign-ins came from the portal source instead. ` +
          'Add an email column, or set HR_COL_EMAIL, then run this again.'
        : hr.reason === 'no_such_table'
          ? `No ${hr.table} table found, so sign-ins came from the portal source instead.`
          : `${hr.table} held no rows with an email address, so the portal source was used.`;
    }

    // Whoever administers the portal always gets a sign-in. Without this, an
    // access rule that excludes their designation locks them out of the thing
    // they are meant to administer - and the only way back in is a database
    // edit. The rule governs everyone else.
    const admins = String(process.env.PORTAL_ADMIN_EMAILS || '')
      .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const have = new Set(people.map((p) => p.email));
    const adminsAdded = [];
    for (const email of admins) {
      const existing = people.find((p) => p.email === email);
      if (existing) { existing.role = 'admin'; continue; }
      const fromHr = (hr.excluded || []).find((e) => e.email === email);
      people.push({
        email,
        name: fromHr?.name || 'Portal Administrator',
        designation: fromHr?.designation || 'IT / Portal Administrator',
        department: 'IT', desk: 'Portal administration',
        role: 'admin', isActive: true,
      });
      if (!have.has(email)) adminsAdded.push(email);
    }

    const seeded = [];
    for (const p of people) {
      await upsertEmployee(p);
      seeded.push(p.email);
    }

    const directory = await listEmployees();
    return json(res, 200, {
      ok: true,
      schema: migrations.length ? 'migrated' : 'already current',
      migrations,
      source,
      sourceNote,
      hrDetectedColumns: hr.mapping,
      accessRule: hr.accessRule,
      noEmail: (hr.skipped || []).length,
      noEmailExamples: (hr.skipped || []).slice(0, 5),
      excludedByAccessRule: (hr.excluded || []).length,
      excludedExamples: (hr.excluded || []).slice(0, 8),
      seeded: seeded.length,
      adminsAlwaysAdmitted: admins,
      adminsAddedOutsideRule: adminsAdded,
      activeEmployees: directory.length,
      conflicts,
      firstPassword: 'MBZ<their email address>',
      next: 'Remove BOOTSTRAP_TOKEN from the environment to close this endpoint.',
      employees: directory.slice(0, 60).map((e) => ({ name: e.name, email: e.email, designation: e.designation })),
    });
  } catch (err) {
    console.error('bootstrap failed', err);
    return json(res, 500, { error: 'bootstrap_failed', message: String(err.message || err) });
  }
}
