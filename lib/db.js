/**
 * Employee directory store (Turso / libSQL).
 *
 * The same client speaks to a remote Turso database (libsql://...) and to a
 * local SQLite file (file:local.db), so the whole auth path can be exercised
 * offline before it is pointed at production.
 */
import { createClient } from '@libsql/client';

let client = null;

export function db() {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
  if (!url) throw new Error('TURSO_DATABASE_URL is not set');
  const authToken = process.env.TURSO_AUTH_TOKEN || undefined;
  client = createClient(url.startsWith('file:') ? { url } : { url, authToken });
  return client;
}

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS employees (
     id                   INTEGER PRIMARY KEY AUTOINCREMENT,
     name                 TEXT NOT NULL,
     email                TEXT NOT NULL UNIQUE,
     designation          TEXT,
     department           TEXT,
     desk                 TEXT,
     role                 TEXT NOT NULL DEFAULT 'buyer',
     password_hash        TEXT,
     must_change_password INTEGER NOT NULL DEFAULT 1,
     is_active            INTEGER NOT NULL DEFAULT 1,
     last_login_at        TEXT,
     created_at           TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS login_audit (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     email      TEXT NOT NULL,
     outcome    TEXT NOT NULL,
     ip         TEXT,
     user_agent TEXT,
     at         TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
];

/**
 * Columns the app requires, with definitions that are legal in
 * ALTER TABLE ADD COLUMN. SQLite refuses a non-constant default there, so
 * created_at and updated_at are added bare when retrofitted - existing rows
 * simply have no timestamp, which is honest about not knowing it.
 */
const REQUIRED_COLUMNS = {
  employees: [
    ['name', 'TEXT'],
    ['email', 'TEXT'],
    ['designation', 'TEXT'],
    ['department', 'TEXT'],
    ['desk', 'TEXT'],
    ['role', "TEXT NOT NULL DEFAULT 'buyer'"],
    ['password_hash', 'TEXT'],
    ['must_change_password', 'INTEGER NOT NULL DEFAULT 1'],
    ['is_active', 'INTEGER NOT NULL DEFAULT 1'],
    ['last_login_at', 'TEXT'],
    ['created_at', 'TEXT'],
    ['updated_at', 'TEXT'],
  ],
  login_audit: [
    ['email', 'TEXT'],
    ['outcome', 'TEXT'],
    ['ip', 'TEXT'],
    ['user_agent', 'TEXT'],
    ['at', 'TEXT'],
  ],
};

const INDEXES = [
  // upsertEmployee uses ON CONFLICT(email), which SQLite only honours when a
  // UNIQUE constraint or index covers that column. A table created by hand
  // usually has neither, so this is not optional.
  ['employees_email_uq', 'CREATE UNIQUE INDEX IF NOT EXISTS employees_email_uq ON employees(email)'],
  ['employees_active_idx', 'CREATE INDEX IF NOT EXISTS employees_active_idx ON employees(is_active)'],
  ['login_audit_email_idx', 'CREATE INDEX IF NOT EXISTS login_audit_email_idx ON login_audit(email, at)'],
];

async function tableExists(c, table) {
  const { rows } = await c.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
    args: [table],
  });
  return rows.length > 0;
}

async function columnsOf(c, table) {
  const { rows } = await c.execute(`PRAGMA table_info(${table})`);
  return rows.map((r) => String(r.name));
}

/**
 * Brings an existing database up to the schema the app expects.
 *
 * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
 * a directory created by hand - or by an older version of this app - keeps
 * whatever columns it had and every query against a newer one fails. This adds
 * what is missing instead, and reports what it changed.
 */
export async function migrate() {
  const c = db();
  const applied = [];

  for (const stmt of SCHEMA) {
    const before = await tableExists(c, /CREATE TABLE IF NOT EXISTS (\w+)/.exec(stmt)[1]);
    await c.execute(stmt);
    if (!before) applied.push(`created table ${/CREATE TABLE IF NOT EXISTS (\w+)/.exec(stmt)[1]}`);
  }

  for (const [table, wanted] of Object.entries(REQUIRED_COLUMNS)) {
    const present = await columnsOf(c, table);
    for (const [column, definition] of wanted) {
      if (present.includes(column)) continue;
      await c.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      applied.push(`added ${table}.${column}`);
    }
  }

  for (const [name, stmt] of INDEXES) {
    try {
      await c.execute(stmt);
    } catch (err) {
      if (name !== 'employees_email_uq') throw err;
      // A unique index cannot be built over duplicate addresses. Name them:
      // guessing which row to drop is not this code's decision to make.
      const { rows } = await c.execute(
        `SELECT email, COUNT(*) AS n FROM employees
          GROUP BY lower(email) HAVING n > 1 ORDER BY n DESC`
      );
      if (!rows.length) throw err;
      const dupes = rows.map((r) => `${r.email} (${r.n})`).join(', ');
      throw new Error(
        `Cannot make employees.email unique - these addresses appear more than once: ${dupes}. ` +
        'Remove the duplicate rows, then run this again.'
      );
    }
  }

  return applied;
}

/** Creates the schema and retrofits anything missing. Safe to re-run. */
export async function initSchema() {
  return migrate();
}
