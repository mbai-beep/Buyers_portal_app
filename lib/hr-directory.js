/**
 * Reads the business's own employee table to populate portal sign-ins.
 *
 * That table is not this app's to shape: it is the HR directory, with its own
 * column names (emp_code, emp_name, emp_designation, hod, ...). So instead of
 * demanding a schema, this detects which column means what and reads it. The
 * table is only ever SELECTed from.
 *
 * Override any guess with environment variables when the heuristics are
 * wrong: HR_TABLE, HR_COL_EMAIL, HR_COL_NAME, HR_COL_DESIGNATION,
 * HR_COL_CODE, HR_COL_DEPARTMENT, HR_COL_ACTIVE.
 */
import { db, columnsOf, listTables, OWNED_TABLES } from './db.js';

const CANDIDATES = {
  email: ['email', 'emp_email', 'email_id', 'emailid', 'official_email', 'mail',
          'emp_mail', 'office_email', 'company_email', 'emp_email_id'],
  name: ['emp_name', 'name', 'employee_name', 'full_name', 'fullname', 'staff_name'],
  designation: ['emp_designation', 'designation', 'title', 'job_title', 'role_title', 'post'],
  code: ['emp_code', 'employee_code', 'staff_code', 'code', 'emp_id', 'employee_id'],
  department: ['department', 'dept', 'emp_department', 'emp_dept', 'division', 'category', 'hod'],
  active: ['is_active', 'active', 'emp_status', 'status', 'is_deleted', 'left'],
};

export function hrTableName() {
  return process.env.HR_TABLE || 'employees';
}

/** Works out which column plays which role, and says how it decided. */
export function mapColumns(columns) {
  const names = columns.map((c) => c.name);
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const mapping = {};
  const notes = [];

  for (const [role, options] of Object.entries(CANDIDATES)) {
    const override = process.env[`HR_COL_${role.toUpperCase()}`];
    if (override) {
      if (!lower.has(override.toLowerCase())) {
        notes.push(`HR_COL_${role.toUpperCase()}="${override}" is not a column in the table`);
        continue;
      }
      mapping[role] = lower.get(override.toLowerCase());
      notes.push(`${role}: ${mapping[role]} (set explicitly)`);
      continue;
    }
    const hit = options.find((o) => lower.has(o));
    if (hit) {
      mapping[role] = lower.get(hit);
      notes.push(`${role}: ${mapping[role]}`);
    }
  }

  // Last resort for email: any column whose name merely contains "mail".
  if (!mapping.email) {
    const loose = names.find((n) => /mail/i.test(n));
    if (loose) {
      mapping.email = loose;
      notes.push(`email: ${loose} (matched on "mail")`);
    }
  }

  return { mapping, notes };
}

const q = (name) => `"${String(name).replace(/"/g, '')}"`;

/**
 * Reads the HR table into the shape portal_users needs.
 * Returns { rows, mapping, notes, skipped, total } - never throws for a
 * missing email column; the caller decides what to do about that.
 */
export async function readHrDirectory() {
  const c = db();
  const table = hrTableName();

  if (OWNED_TABLES.includes(table)) {
    throw new Error(`HR_TABLE is set to ${table}, which is one of this app's own tables`);
  }
  const tables = await listTables(c);
  if (!tables.includes(table)) {
    return { available: false, table, reason: 'no_such_table', tables, rows: [], mapping: {}, notes: [] };
  }

  const columns = await columnsOf(table, c);
  const { mapping, notes } = mapColumns(columns);

  if (!mapping.email) {
    return {
      available: false, table, reason: 'no_email_column',
      columns: columns.map((col) => col.name), mapping, notes, rows: [],
    };
  }

  const select = [
    `${q(mapping.email)} AS email`,
    mapping.name ? `${q(mapping.name)} AS name` : `NULL AS name`,
    mapping.designation ? `${q(mapping.designation)} AS designation` : `NULL AS designation`,
    mapping.code ? `${q(mapping.code)} AS code` : `NULL AS code`,
    mapping.department ? `${q(mapping.department)} AS department` : `NULL AS department`,
    mapping.active ? `${q(mapping.active)} AS active_raw` : `NULL AS active_raw`,
  ].join(', ');

  const { rows } = await c.execute(`SELECT ${select} FROM ${q(table)}`);

  const out = [];
  const skipped = [];
  for (const r of rows) {
    const email = String(r.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      skipped.push({ code: r.code ?? null, name: r.name ?? null, reason: email ? 'invalid email' : 'no email' });
      continue;
    }
    out.push({
      email,
      name: String(r.name ?? '').trim() || email.split('@')[0],
      designation: r.designation != null ? String(r.designation).trim() : null,
      department: r.department != null ? String(r.department).trim() : null,
      desk: null,
      employeeCode: r.code != null ? String(r.code) : null,
      isActive: activeFrom(r.active_raw, mapping.active),
      role: 'buyer',
    });
  }

  return { available: true, table, mapping, notes, rows: out, skipped, total: rows.length };
}

/**
 * An "active" column can mean the opposite of what it says: is_deleted and
 * left are inverted, and status is usually a word.
 */
function activeFrom(value, columnName) {
  if (value == null || !columnName) return true;
  const inverted = /deleted|left|resign|inactive|disabled/i.test(columnName);
  const s = String(value).trim().toLowerCase();

  let truthy;
  if (s === '' ) truthy = true;
  else if (['1', 'y', 'yes', 'true', 't', 'active', 'a', 'working', 'current'].includes(s)) truthy = true;
  else if (['0', 'n', 'no', 'false', 'f', 'inactive', 'left', 'resigned', 'deleted', 'exit'].includes(s)) truthy = false;
  else truthy = true;  // an unrecognised status must not silently lock someone out

  return inverted ? !truthy : truthy;
}
