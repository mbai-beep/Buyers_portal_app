import { db } from './db.js';
import { normaliseEmail } from './http.js';

function adminEmails() {
  return String(process.env.PORTAL_ADMIN_EMAILS || '')
    .split(',').map(normaliseEmail).filter(Boolean);
}

function shape(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    designation: row.designation || '',
    department: row.department || '',
    desk: row.desk || row.department || '',
    role: row.role || 'buyer',
    isActive: Number(row.is_active) === 1,
    mustChangePassword: Number(row.must_change_password) === 1,
    passwordHash: row.password_hash || null,
    lastLoginAt: row.last_login_at || null,
  };
}

/** Strips anything the browser has no business seeing. */
export function publicView(emp) {
  if (!emp) return null;
  const { passwordHash, ...rest } = emp;
  return { ...rest, isAdmin: adminEmails().includes(emp.email) || emp.role === 'admin' };
}

export async function findByEmail(email) {
  const e = normaliseEmail(email);
  if (!e) return null;
  const { rows } = await db().execute({
    sql: 'SELECT * FROM employees WHERE email = ? LIMIT 1',
    args: [e],
  });
  return shape(rows[0]);
}

export async function findById(id) {
  const { rows } = await db().execute({
    sql: 'SELECT * FROM employees WHERE id = ? LIMIT 1',
    args: [Number(id)],
  });
  return shape(rows[0]);
}

/**
 * The directory as colleagues see it: who someone is and what they do.
 * Account state (whether they are still on the issued password, when they last
 * signed in) is nobody else's business, so it is only included for an admin.
 */
export async function listEmployees({ includeInactive = false, full = false } = {}) {
  const { rows } = await db().execute(
    includeInactive
      ? 'SELECT * FROM employees ORDER BY name'
      : 'SELECT * FROM employees WHERE is_active = 1 ORDER BY name'
  );
  const people = rows.map(shape).map(publicView);
  if (full) return people;
  return people.map(({ id, name, email, designation, department, desk, role }) =>
    ({ id, name, email, designation, department, desk, role }));
}

export async function upsertEmployee({ name, email, designation, department, desk, role }) {
  const e = normaliseEmail(email);
  await db().execute({
    sql: `INSERT INTO employees (name, email, designation, department, desk, role)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(email) DO UPDATE SET
            name        = excluded.name,
            designation = excluded.designation,
            department  = excluded.department,
            desk        = excluded.desk,
            role        = excluded.role,
            updated_at  = datetime('now')`,
    args: [name, e, designation ?? null, department ?? null, desk ?? null, role || 'buyer'],
  });
  return findByEmail(e);
}

export async function setPasswordHash(id, hash, { mustChange }) {
  await db().execute({
    sql: `UPDATE employees
             SET password_hash = ?, must_change_password = ?, updated_at = datetime('now')
           WHERE id = ?`,
    args: [hash, mustChange ? 1 : 0, Number(id)],
  });
}

export async function touchLogin(id) {
  await db().execute({
    sql: `UPDATE employees SET last_login_at = datetime('now') WHERE id = ?`,
    args: [Number(id)],
  });
}

export async function audit(email, outcome, ip, userAgent) {
  try {
    await db().execute({
      sql: 'INSERT INTO login_audit (email, outcome, ip, user_agent) VALUES (?, ?, ?, ?)',
      args: [normaliseEmail(email), outcome, ip || null, String(userAgent || '').slice(0, 300)],
    });
  } catch {
    // Auditing must never block a login.
  }
}

/** Recent failures for one email, used for a soft lockout. */
export async function recentFailures(email, minutes = 15) {
  try {
    const { rows } = await db().execute({
      sql: `SELECT COUNT(*) AS n FROM login_audit
             WHERE email = ? AND outcome = 'bad_password'
               AND at > datetime('now', ?)`,
      args: [normaliseEmail(email), `-${Math.max(1, minutes)} minutes`],
    });
    return Number(rows[0]?.n || 0);
  } catch {
    return 0;
  }
}
