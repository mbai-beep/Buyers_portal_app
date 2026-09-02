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
  `CREATE INDEX IF NOT EXISTS employees_active_idx ON employees(is_active)`,
  `CREATE TABLE IF NOT EXISTS login_audit (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     email      TEXT NOT NULL,
     outcome    TEXT NOT NULL,
     ip         TEXT,
     user_agent TEXT,
     at         TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE INDEX IF NOT EXISTS login_audit_email_idx ON login_audit(email, at)`,
];

export async function initSchema() {
  const c = db();
  for (const stmt of SCHEMA) await c.execute(stmt);
}
