/**
 * The zRetailHQ0 reporting views behind the portal's screens.
 *
 * Column names in these views are not guessed at: VIEWS lists what each one
 * is for, and describeViews() reads the real column list off the server so
 * queries are written against what is actually there. Nothing here writes -
 * every statement is a SELECT against a view.
 */
import { query, sql } from './sql.js';

export const VIEWS = {
  purchases: {
    name: process.env.SQL_VIEW_PURCHASES || 'VW_MB_POWERBI_PUR_REPORT',
    what: 'Purchases - what was bought in, by supplier and article',
  },
  purchaseReturns: {
    name: process.env.SQL_VIEW_PURCHASE_RETURNS || 'VW_MB_POWERBI_PRT_REPORT',
    what: 'Purchase returns - what went back to the supplier',
  },
  sales: {
    name: process.env.SQL_VIEW_SALES || 'VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID',
    what: 'Sales - what sold, without item id',
  },
};

/** A view or table name is never interpolated raw. */
function safeObjectName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(String(name))) {
    throw new Error(`unsafe object name: ${name}`);
  }
  return String(name);
}

export async function serverInfo() {
  const rows = await query(
    `SELECT DB_NAME() AS [database], SUSER_SNAME() AS [login],
            SYSDATETIME() AS [serverTime], LEFT(@@VERSION, 110) AS [version]`
  );
  return rows[0];
}

/** Column list and row count for one view. */
export async function describeView(name) {
  const object = safeObjectName(name);
  const [schema, bare] = object.includes('.') ? object.split('.') : [null, object];

  const columns = await query(
    `SELECT c.name AS [column], t.name AS [type], c.max_length AS [length],
            c.precision AS [precision], c.scale AS [scale], c.is_nullable AS [nullable]
       FROM sys.columns c
       JOIN sys.types  t ON t.user_type_id = c.user_type_id
      WHERE c.object_id = OBJECT_ID(@object)
      ORDER BY c.column_id`,
    { object: { type: sql.NVarChar, value: object } }
  );

  if (!columns.length) {
    const near = await query(
      `SELECT TOP 12 TABLE_SCHEMA + '.' + TABLE_NAME AS [name]
         FROM INFORMATION_SCHEMA.VIEWS
        WHERE TABLE_NAME LIKE @like
        ORDER BY TABLE_NAME`,
      { like: { type: sql.NVarChar, value: `%${bare.split('_').slice(-2).join('_')}%` } }
    );
    return { name: object, found: false, similarlyNamed: near.map((r) => r.name) };
  }

  let rowCount = null;
  try {
    const c = await query(`SELECT COUNT_BIG(*) AS n FROM ${object} WITH (NOLOCK)`);
    rowCount = Number(c[0]?.n ?? 0);
  } catch (err) {
    rowCount = `unavailable: ${err.message}`;
  }

  return {
    name: object,
    found: true,
    rowCount,
    columnCount: columns.length,
    columns: columns.map((c) =>
      `${c.column} ${c.type}${c.length && c.type.includes('char') ? `(${c.length})` : ''}` +
      `${c.nullable ? '' : ' NOT NULL'}`),
  };
}

export async function describeViews() {
  const out = {};
  for (const [key, def] of Object.entries(VIEWS)) {
    try {
      out[key] = { ...def, ...(await describeView(def.name)) };
    } catch (err) {
      out[key] = { ...def, found: false, error: String(err.message || err) };
    }
  }
  return out;
}
