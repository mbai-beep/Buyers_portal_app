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
  email: ['mailid', 'mail_id', 'email', 'emp_email', 'email_id', 'emailid',
          'official_email', 'mail', 'emp_mail', 'office_email', 'company_email'],
  name: ['emp_name', 'name', 'employee_name', 'full_name', 'fullname', 'staff_name'],
  designation: ['emp_designation', 'designation', 'title', 'job_title', 'post'],
  code: ['emp_code', 'employee_code', 'staff_code', 'code', 'emp_id', 'employee_id'],
  department: ['department', 'dept', 'emp_department', 'emp_dept', 'division'],
  // The person this employee reports to - a name, not a department. Kept
  // separate from `department` so "hod" is not mistaken for one.
  manager: ['hod', 'reporting_to', 'reports_to', 'manager', 'supervisor'],
  storeCode: ['store_code', 'branch_code', 'location_code'],
  storeName: ['store_name', 'branch_name', 'location', 'store'],
  city: ['city', 'town'],
  // Deliberately NOT 'role': an HR role column describes the job, and reading
  // authorisation out of it would let an HR edit grant portal admin. The
  // portal's own role is set from PORTAL_ADMIN_EMAILS only.
  active: ['is_active', 'active', 'emp_status', 'employee_status', 'is_deleted', 'left', 'resigned'],
  jobRole: ['role', 'emp_role', 'job_role'],
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

  const pick = (role, alias) =>
    mapping[role] ? `${q(mapping[role])} AS ${alias}` : `NULL AS ${alias}`;

  const select = [
    `${q(mapping.email)} AS email`,
    pick('name', 'name'), pick('designation', 'designation'),
    pick('code', 'code'), pick('department', 'department'),
    pick('manager', 'manager'), pick('storeCode', 'store_code'),
    pick('storeName', 'store_name'), pick('city', 'city'),
    pick('jobRole', 'job_role'), pick('active', 'active_raw'),
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
    const text = (v) => (v != null && String(v).trim() !== '' ? String(v).trim() : null);
    const designation = text(r.designation) || text(r.job_role);

    out.push({
      email,
      name: text(r.name) || email.split('@')[0],
      designation,
      // No department column in a store-based directory, so the store is the
      // useful grouping; the city disambiguates same-named stores.
      department: text(r.department) || text(r.store_name) || text(r.city),
      desk: text(r.store_name) && text(r.city) ? `${text(r.store_name)}, ${text(r.city)}` : text(r.store_name),
      manager: text(r.manager),
      storeCode: text(r.store_code),
      employeeCode: text(r.code),
      isActive: activeFrom(r.active_raw, mapping.active),
      // Authorisation never comes from HR data - see CANDIDATES above.
      role: 'buyer',
      _designationForFilter: designation || '',
      _jobRoleForFilter: text(r.job_role) || '',
    });
  }

  const { kept, excluded, rule } = applyAccessRule(out);

  return {
    available: true, table, mapping, notes,
    rows: kept, excluded, accessRule: rule,
    skipped, total: rows.length,
  };
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


/**
 * Who in the HR directory gets a portal sign-in.
 *
 * The directory covers the whole chain - store managers, sales and stock
 * executives across every city. This app shows supplier rankings, the whole
 * buying book and what the company owes, which is not store-floor
 * information. So the default is the buying side only, and taking everyone
 * is a deliberate choice rather than a side effect of importing a table.
 *
 *   HR_INCLUDE_ALL=1                 every row with a valid email
 *   HR_INCLUDE_DESIGNATIONS=a,b,c    substrings matched against the designation
 *   neither                          the buying-side default below
 */
const BUYING_SIDE = ['owner', 'buyer', 'buying', 'merchandis', 'category',
                     'proprietor', 'director', 'vendor', 'accounts', 'logistic'];

export function applyAccessRule(people) {
  const clean = (p) => { delete p._designationForFilter; delete p._jobRoleForFilter; return p; };

  if (process.env.HR_INCLUDE_ALL === '1') {
    return {
      kept: people.map(clean), excluded: [],
      rule: 'every employee with a valid email (HR_INCLUDE_ALL=1)',
    };
  }

  // Matching the directory's own role column is exact, so it beats guessing
  // from designation text when the column is populated.
  const roles = String(process.env.HR_INCLUDE_ROLES || '')
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

  const designations = String(process.env.HR_INCLUDE_DESIGNATIONS || '')
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

  let matches, rule;
  if (roles.length) {
    matches = (p) => roles.includes(String(p._jobRoleForFilter || '').toLowerCase());
    rule = `role column in: ${roles.join(', ')} (HR_INCLUDE_ROLES)`;
  } else {
    const terms = designations.length ? designations : BUYING_SIDE;
    matches = (p) => terms.some((t) => String(p._designationForFilter || '').toLowerCase().includes(t));
    rule = designations.length
      ? `designation matching: ${terms.join(', ')} (HR_INCLUDE_DESIGNATIONS)`
      : `the buying side by default: ${terms.join(', ')}`;
  }

  const kept = [];
  const excluded = [];
  for (const p of people) {
    if (matches(p)) kept.push(p);
    else excluded.push({ name: p.name, designation: p.designation, role: p._jobRoleForFilter || null, email: p.email });
  }
  return { kept: kept.map(clean), excluded, rule };
}
