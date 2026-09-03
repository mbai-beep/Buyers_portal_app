/**
 * Employee directory store (Turso / libSQL).
 *
 * The same client speaks to a remote Turso database (libsql://...) and to a
 * local SQLite file (file:local.db), so the whole auth path can be exercised
 * offline before it is pointed at production.
 *
 * Two kinds of table live here and they are NOT the same thing:
 *
 *   portal_users  - owned by this app. Sign-in identity and password state.
 *                   Created and migrated freely.
 *   employees     - the HR directory, owned by the business. Read only.
 *                   Never created, never altered, never written to. An
 *                   earlier version of this file migrated it as if the app
 *                   owned it; it does not.
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

/** Tables this app owns and may alter. Anything else is somebody else's data. */
export const OWNED_TABLES = [
  'portal_users', 'login_audit',
  'portal_orders', 'portal_order_lines', 'portal_captures',
];

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS portal_users (
     id                   INTEGER PRIMARY KEY AUTOINCREMENT,
     email                TEXT NOT NULL UNIQUE,
     name                 TEXT NOT NULL,
     designation          TEXT,
     department           TEXT,
     desk                 TEXT,
     role                 TEXT NOT NULL DEFAULT 'buyer',
     employee_code        TEXT,
     store_code           TEXT,
     manager              TEXT,
     password_hash        TEXT,
     must_change_password INTEGER NOT NULL DEFAULT 1,
     is_active            INTEGER NOT NULL DEFAULT 1,
     last_login_at        TEXT,
     created_at           TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  /*
   * Purchase orders raised in the portal.
   *
   * These are the app's own records: zRetailHQ0's views are read-only and
   * carry completed purchases, not orders a buyer has just raised. An order
   * lands here first and is mirrored to the Google Sheet afterwards, so a
   * spreadsheet being unreachable can never lose one.
   */
  `CREATE TABLE IF NOT EXISTS portal_orders (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     order_no       TEXT NOT NULL UNIQUE,
     supplier_alias TEXT NOT NULL,
     supplier_name  TEXT,
     raised_by      TEXT NOT NULL,
     raised_by_name TEXT,
     order_date     TEXT NOT NULL,
     wanted_by      TEXT,
     terms_days     INTEGER,
     note           TEXT,
     total_qty      INTEGER NOT NULL DEFAULT 0,
     total_value    REAL NOT NULL DEFAULT 0,
     status         TEXT NOT NULL DEFAULT 'raised',
     sheet_synced   INTEGER NOT NULL DEFAULT 0,
     sheet_error    TEXT,
     created_at     TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS portal_order_lines (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     order_id    INTEGER NOT NULL,
     order_no    TEXT NOT NULL,
     article_no  TEXT NOT NULL,
     colour      TEXT,
     size_name   TEXT,
     qty         INTEGER NOT NULL DEFAULT 0,
     rate        REAL,
     line_value  REAL,
     created_at  TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  /* Anything else the portal captures from a person, kept whether or not the
     spreadsheet accepted it. */
  `CREATE TABLE IF NOT EXISTS portal_captures (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     kind         TEXT NOT NULL,
     ref          TEXT,
     captured_by  TEXT NOT NULL,
     payload      TEXT NOT NULL,
     sheet_synced INTEGER NOT NULL DEFAULT 0,
     sheet_error  TEXT,
     created_at   TEXT NOT NULL DEFAULT (datetime('now'))
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
 * Columns the app requires, in definitions legal for ALTER TABLE ADD COLUMN
 * (SQLite refuses a non-constant default there, so the timestamps are added
 * bare when retrofitted onto an older portal_users).
 */
const REQUIRED_COLUMNS = {
  portal_users: [
    ['email', 'TEXT'], ['name', 'TEXT'], ['designation', 'TEXT'],
    ['department', 'TEXT'], ['desk', 'TEXT'],
    ['role', "TEXT NOT NULL DEFAULT 'buyer'"], ['employee_code', 'TEXT'],
    ['store_code', 'TEXT'], ['manager', 'TEXT'], ['password_hash', 'TEXT'],
    ['must_change_password', 'INTEGER NOT NULL DEFAULT 1'],
    ['is_active', 'INTEGER NOT NULL DEFAULT 1'],
    ['last_login_at', 'TEXT'], ['created_at', 'TEXT'], ['updated_at', 'TEXT'],
  ],
  login_audit: [
    ['email', 'TEXT'], ['outcome', 'TEXT'], ['ip', 'TEXT'],
    ['user_agent', 'TEXT'], ['at', 'TEXT'],
  ],
  portal_orders: [
    ['order_no', 'TEXT'], ['supplier_alias', 'TEXT'], ['supplier_name', 'TEXT'],
    ['raised_by', 'TEXT'], ['raised_by_name', 'TEXT'], ['order_date', 'TEXT'],
    ['wanted_by', 'TEXT'], ['terms_days', 'INTEGER'], ['note', 'TEXT'],
    ['total_qty', 'INTEGER NOT NULL DEFAULT 0'], ['total_value', 'REAL NOT NULL DEFAULT 0'],
    ['status', "TEXT NOT NULL DEFAULT 'raised'"],
    ['sheet_synced', 'INTEGER NOT NULL DEFAULT 0'], ['sheet_error', 'TEXT'],
    ['created_at', 'TEXT'], ['updated_at', 'TEXT'],
  ],
  portal_order_lines: [
    ['order_id', 'INTEGER'], ['order_no', 'TEXT'], ['article_no', 'TEXT'],
    ['colour', 'TEXT'], ['size_name', 'TEXT'], ['qty', 'INTEGER NOT NULL DEFAULT 0'],
    ['rate', 'REAL'], ['line_value', 'REAL'], ['created_at', 'TEXT'],
  ],
  portal_captures: [
    ['kind', 'TEXT'], ['ref', 'TEXT'], ['captured_by', 'TEXT'], ['payload', 'TEXT'],
    ['sheet_synced', 'INTEGER NOT NULL DEFAULT 0'], ['sheet_error', 'TEXT'],
    ['created_at', 'TEXT'],
  ],
};

const INDEXES = [
  ['portal_users_email_uq',
   'CREATE UNIQUE INDEX IF NOT EXISTS portal_users_email_uq ON portal_users(email)'],
  ['portal_users_active_idx',
   'CREATE INDEX IF NOT EXISTS portal_users_active_idx ON portal_users(is_active)'],
  ['login_audit_email_idx',
   'CREATE INDEX IF NOT EXISTS login_audit_email_idx ON login_audit(email, at)'],
  ['portal_orders_no_uq',
   'CREATE UNIQUE INDEX IF NOT EXISTS portal_orders_no_uq ON portal_orders(order_no)'],
  ['portal_orders_supplier_idx',
   'CREATE INDEX IF NOT EXISTS portal_orders_supplier_idx ON portal_orders(supplier_alias, order_date)'],
  ['portal_order_lines_order_idx',
   'CREATE INDEX IF NOT EXISTS portal_order_lines_order_idx ON portal_order_lines(order_id)'],
  ['portal_captures_kind_idx',
   'CREATE INDEX IF NOT EXISTS portal_captures_kind_idx ON portal_captures(kind, created_at)'],
];

export async function listTables(c = db()) {
  const { rows } = await c.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  return rows.map((r) => String(r.name));
}

export async function columnsOf(table, c = db()) {
  const { rows } = await c.execute(`PRAGMA table_info("${String(table).replace(/"/g, '')}")`);
  return rows.map((r) => ({ name: String(r.name), type: String(r.type || ''), notNull: Number(r.notnull) === 1 }));
}

/**
 * Creates and updates only the tables this app owns.
 *
 * Every ALTER is guarded by OWNED_TABLES, so a table the business owns cannot
 * be modified even if a future column list names it by accident.
 */
export async function migrate() {
  const c = db();
  const applied = [];
  const existing = await listTables(c);

  for (const stmt of SCHEMA) {
    const table = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(stmt)[1];
    if (!OWNED_TABLES.includes(table)) {
      throw new Error(`refusing to create ${table}: not a table this app owns`);
    }
    await c.execute(stmt);
    if (!existing.includes(table)) applied.push(`created table ${table}`);
  }

  for (const [table, wanted] of Object.entries(REQUIRED_COLUMNS)) {
    if (!OWNED_TABLES.includes(table)) {
      throw new Error(`refusing to alter ${table}: not a table this app owns`);
    }
    const present = (await columnsOf(table, c)).map((col) => col.name);
    for (const [column, definition] of wanted) {
      if (present.includes(column)) continue;
      try {
        await c.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        applied.push(`added ${table}.${column}`);
      } catch (err) {
        // Two instances migrating at once is normal on a cold deploy.
        if (!/duplicate column|already exists/i.test(String(err?.message || err))) throw err;
      }
    }
  }

  for (const [name, stmt] of INDEXES) {
    try {
      await c.execute(stmt);
    } catch (err) {
      if (name !== 'portal_users_email_uq') throw err;
      const { rows } = await c.execute(
        `SELECT email, COUNT(*) AS n FROM portal_users
          GROUP BY lower(email) HAVING n > 1 ORDER BY n DESC`
      );
      if (!rows.length) throw err;
      throw new Error(
        'Cannot make portal_users.email unique - these addresses appear more than once: ' +
        rows.map((r) => `${r.email} (${r.n})`).join(', ') +
        '. Remove the duplicates, then run this again.'
      );
    }
  }

  return applied;
}

/** Creates the app's own tables and retrofits anything missing. Safe to re-run. */
export async function initSchema() {
  return migrate();
}

/*
 * Making the schema self-healing.
 *
 * portal_orders was added to SCHEMA but only ever created by the bootstrap
 * endpoint, so a deployment that shipped the orders feature without anyone
 * re-running bootstrap answered "no such table: portal_orders". Requiring a
 * manual step after a deploy to create the app's own tables is a trap, and it
 * caught us.
 *
 * ensureSchema() runs the migration once per instance. withSchema() is the
 * cheap version: it runs the query, and only if it fails for a missing table
 * or column does it migrate and try again. Normal requests pay nothing.
 */
let ensuring = null;

export function resetSchemaGuard() { ensuring = null; }

export async function ensureSchema() {
  if (!ensuring) {
    ensuring = migrate().catch((err) => {
      ensuring = null;                 // a failure must not be cached
      throw err;
    });
  }
  return ensuring;
}

const MISSING = /no such table|no such column|SQLITE_UNKNOWN/i;

export async function withSchema(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!MISSING.test(String(err?.message || err))) throw err;
    console.warn('schema looks out of date, migrating and retrying:', err?.message || err);
    await ensureSchema();
    return fn();
  }
}
