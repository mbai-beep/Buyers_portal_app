/**
 * The zRetailHQ0 reporting views behind the portal's figures.
 *
 * Column names here are the real ones, read off the server rather than
 * assumed. Everything is a SELECT against a view - this module never writes.
 *
 * A note on the sales view. It carries three quantity pairs:
 *
 *   SLSQty / SLSNetAmount   sales
 *   SLRQty / SLRNetAmount   sales returns
 *   SalesQuantity / SalesNetAmount
 *
 * Whether the third pair is gross or already net of returns decides every
 * figure on the home screen, and it is not knowable from a column list. So
 * nothing here guesses: net is always computed as SLS minus SLR, and
 * reconcileSales() reports all three side by side so the question is settled
 * against real data. See /api/reports/reconcile.
 */
import { query, sql } from './sql.js';

export const VIEWS = {
  purchases: {
    name: process.env.SQL_VIEW_PURCHASES || 'VW_MB_POWERBI_PUR_REPORT',
    what: 'Purchases - what was bought in, by supplier and article',
    dateColumn: 'PurchaseDt',
  },
  purchaseReturns: {
    name: process.env.SQL_VIEW_PURCHASE_RETURNS || 'VW_MB_POWERBI_PRT_REPORT',
    what: 'Purchase returns - what went back to the supplier',
    dateColumn: 'PurReturnDt',
  },
  sales: {
    name: process.env.SQL_VIEW_SALES || 'VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID',
    what: 'Sales and sales returns, by branch, supplier and article',
    dateColumn: 'CashmemoDt',
  },
};

/**
 * Reporting scans run with READ UNCOMMITTED by default: this is a live retail
 * database and a full scan of the sales view holding locks would sit in front
 * of the tills. The cost is that a figure can move by whatever is mid-transaction
 * at that instant. Set SQL_NOLOCK=false for strict reads.
 */
const HINT = process.env.SQL_NOLOCK === 'false' ? '' : ' WITH (NOLOCK)';

const PUR = () => safeName(VIEWS.purchases.name) + HINT;
const PRT = () => safeName(VIEWS.purchaseReturns.name) + HINT;
const SLS = () => safeName(VIEWS.sales.name) + HINT;

function safeName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(String(name))) {
    throw new Error(`unsafe object name: ${name}`);
  }
  return String(name);
}

const D = (v) => ({ type: sql.Date, value: v });
const S = (v) => ({ type: sql.NVarChar, value: v });
const num = (v) => (v == null ? 0 : Number(v));

/** Whole numbers only, so a limit can never be injected into TOP. */
function topN(n, fallback = 50, max = 2000) {
  const i = Math.floor(Number(n));
  if (!Number.isFinite(i) || i < 1) return fallback;
  return Math.min(i, max);
}

/* ------------------------------------------------------------------ dates */

export function financialYearStart(on = new Date()) {
  const y = on.getUTCFullYear();
  const m = on.getUTCMonth() + 1;      // April to March
  return `${m >= 4 ? y : y - 1}-04-01`;
}

export function isoDate(v) {
  const s = String(v ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`expected a YYYY-MM-DD date, got "${s}"`);
  return s;
}

/* ------------------------------------------------------- warm-instance cache */

const cache = new Map();
const TTL = Number(process.env.REPORT_CACHE_SECONDS || 300) * 1000;

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

export function clearCache() { cache.clear(); }

/* ------------------------------------------------------------- the figures */

/**
 * Sales for a period. Net is SLS minus SLR; the reported pair is carried
 * alongside so a mismatch is visible rather than silently chosen between.
 */
export async function salesTotals({ from, to }) {
  const rows = await query(
    `SELECT CAST(SUM(ISNULL(SLSQty, 0))        AS float) AS grossQty,
            CAST(SUM(ISNULL(SLRQty, 0))        AS float) AS returnQty,
            CAST(SUM(ISNULL(SLSNetAmount, 0))  AS float) AS grossValue,
            CAST(SUM(ISNULL(SLRNetAmount, 0))  AS float) AS returnValue,
            CAST(SUM(ISNULL(SalesQuantity, 0)) AS float) AS reportedQty,
            CAST(SUM(ISNULL(SalesNetAmount,0)) AS float) AS reportedValue,
            COUNT(DISTINCT CashmemoNo)                   AS bills,
            COUNT(DISTINCT ArticleNo)                    AS articles,
            COUNT(DISTINCT SupplierAlias)                AS suppliers,
            COUNT(DISTINCT BranchAlias)                  AS branches
       FROM ${SLS()}
      WHERE CashmemoDt >= @from AND CashmemoDt <= @to`,
    { from: D(isoDate(from)), to: D(isoDate(to)) }
  );
  const r = rows[0] || {};
  return {
    grossQty: num(r.grossQty), returnQty: num(r.returnQty),
    netQty: num(r.grossQty) - num(r.returnQty),
    grossValue: num(r.grossValue), returnValue: num(r.returnValue),
    netValue: num(r.grossValue) - num(r.returnValue),
    reportedQty: num(r.reportedQty), reportedValue: num(r.reportedValue),
    bills: num(r.bills), articles: num(r.articles),
    suppliers: num(r.suppliers), branches: num(r.branches),
  };
}

export async function purchaseTotals({ from, to } = {}) {
  const where = from && to ? 'WHERE PurchaseDt >= @from AND PurchaseDt <= @to' : '';
  const args = from && to ? { from: D(isoDate(from)), to: D(isoDate(to)) } : {};
  const rows = await query(
    `SELECT CAST(SUM(ISNULL(PurQty, 0))       AS float) AS qty,
            CAST(SUM(ISNULL(PurNetAmount, 0)) AS float) AS value,
            COUNT(DISTINCT SupplierAlias)               AS suppliers,
            COUNT(DISTINCT ArticleNo)                   AS articles,
            COUNT(DISTINCT PurInvoiceNo)                AS invoices
       FROM ${PUR()} ${where}`,
    args
  );
  const r = rows[0] || {};
  return {
    qty: num(r.qty), value: num(r.value), suppliers: num(r.suppliers),
    articles: num(r.articles), invoices: num(r.invoices),
  };
}

export async function purchaseReturnTotals({ from, to } = {}) {
  const where = from && to ? 'WHERE PurReturnDt >= @from AND PurReturnDt <= @to' : '';
  const args = from && to ? { from: D(isoDate(from)), to: D(isoDate(to)) } : {};
  const rows = await query(
    `SELECT CAST(SUM(ISNULL(PrtQty, 0))       AS float) AS qty,
            CAST(SUM(ISNULL(PrtNetAmount, 0)) AS float) AS value,
            COUNT(DISTINCT PurReturnId)                 AS notes
       FROM ${PRT()} ${where}`,
    args
  );
  const r = rows[0] || {};
  return { qty: num(r.qty), value: num(r.value), notes: num(r.notes) };
}

/**
 * The home tiles.
 *
 * "With us right now" is a derived figure, not a stock table: everything ever
 * bought, less what went back to suppliers, less what has net sold. It is
 * therefore only as right as the views' history is complete, which is why it
 * is reported with the three parts it is made of rather than as a bare number.
 */
export async function homeTotals({ from, to }) {
  return cached(`home:${from}:${to}:${HINT}`, async () => {
    const fyFrom = financialYearStart(new Date(`${to}T00:00:00Z`));
    const [period, fy, purAll, prtAll, purFy, soldEver] = await Promise.all([
      salesTotals({ from, to }),
      salesTotals({ from: fyFrom, to }),
      purchaseTotals(),
      purchaseReturnTotals(),
      purchaseTotals({ from: fyFrom, to }),
      netSoldEver(),
    ]);

    const balance = purAll.qty - prtAll.qty - soldEver;
    return {
      period: { from, to },
      financialYearFrom: fyFrom,
      sold: { qty: period.netQty, value: period.netValue, gross: period.grossQty, returns: period.returnQty },
      soldThisYear: { qty: fy.netQty, value: fy.netValue },
      withUs: {
        qty: balance,
        derivedFrom: { purchasedEver: purAll.qty, returnedToSuppliers: prtAll.qty, netSoldEver: soldEver },
        note: 'purchased ever, less returned to suppliers, less net sold ever',
      },
      suppliers: purAll.suppliers,
      designsThisYear: purFy.articles,
      designsEver: purAll.articles,
      purchasedThisYear: { qty: purFy.qty, value: purFy.value },
      salesReportedVsComputed: {
        reportedQty: period.reportedQty, computedNetQty: period.netQty,
        agrees: Math.abs(period.reportedQty - period.netQty) < 1,
      },
    };
  });
}

/** Net sold across all time - needed for the balance figure. */
export async function netSoldEver() {
  const rows = await query(
    `SELECT CAST(SUM(ISNULL(SLSQty, 0)) AS float) AS grossQty,
            CAST(SUM(ISNULL(SLRQty, 0)) AS float) AS returnQty
       FROM ${SLS()}`
  );
  const r = rows[0] || {};
  return num(r.grossQty) - num(r.returnQty);
}

export async function bestSellers({ from, to, limit = 50 }) {
  const n = topN(limit, 50);
  return query(
    `SELECT TOP ${n}
            ArticleNo, ColourName,
            MAX(SupplierAlias) AS SupplierAlias, MAX(SupplierName) AS SupplierName,
            MAX(DepartmentShortName) AS Department, MAX(CategoryShortName) AS Category,
            CAST(SUM(ISNULL(SLSQty,0)) - SUM(ISNULL(SLRQty,0)) AS float) AS netQty,
            CAST(SUM(ISNULL(SLSNetAmount,0)) - SUM(ISNULL(SLRNetAmount,0)) AS float) AS netValue,
            CAST(SUM(ISNULL(SLRQty,0)) AS float) AS returnQty,
            CAST(MAX(ItemMRP) AS float) AS mrp,
            COUNT(DISTINCT BranchAlias) AS branches
       FROM ${SLS()}
      WHERE CashmemoDt >= @from AND CashmemoDt <= @to
      GROUP BY ArticleNo, ColourName
      ORDER BY netQty DESC`,
    { from: D(isoDate(from)), to: D(isoDate(to)) }
  );
}

export async function dailySales({ from, to }) {
  const rows = await query(
    `SELECT CashmemoDt AS d,
            CAST(SUM(ISNULL(SLSQty,0)) - SUM(ISNULL(SLRQty,0)) AS float) AS netQty,
            CAST(SUM(ISNULL(SLSNetAmount,0)) - SUM(ISNULL(SLRNetAmount,0)) AS float) AS netValue
       FROM ${SLS()}
      WHERE CashmemoDt >= @from AND CashmemoDt <= @to
      GROUP BY CashmemoDt
      ORDER BY CashmemoDt`,
    { from: D(isoDate(from)), to: D(isoDate(to)) }
  );
  return rows.map((r) => ({
    date: r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10),
    qty: num(r.netQty), value: num(r.netValue),
  }));
}

/** The book: every supplier, with what was bought, returned and sold. */
export async function supplierBook({ from, to, limit = 500 }) {
  const n = topN(limit, 500, 5000);
  const [purchases, sales, returns] = await Promise.all([
    query(
      `SELECT SupplierAlias, MAX(SupplierName) AS SupplierName, MAX(SupplierCity) AS SupplierCity,
              CAST(SUM(ISNULL(PurQty,0)) AS float) AS purQty,
              CAST(SUM(ISNULL(PurNetAmount,0)) AS float) AS purValue,
              COUNT(DISTINCT ArticleNo) AS articles,
              MAX(DepartmentShortName) AS Department
         FROM ${PUR()}
        GROUP BY SupplierAlias`
    ),
    query(
      `SELECT SupplierAlias,
              CAST(SUM(ISNULL(SLSQty,0)) - SUM(ISNULL(SLRQty,0)) AS float) AS netQty,
              CAST(SUM(ISNULL(SLSNetAmount,0)) - SUM(ISNULL(SLRNetAmount,0)) AS float) AS netValue
         FROM ${SLS()}
        WHERE CashmemoDt >= @from AND CashmemoDt <= @to
        GROUP BY SupplierAlias`,
      { from: D(isoDate(from)), to: D(isoDate(to)) }
    ),
    query(
      `SELECT SupplierAlias, CAST(SUM(ISNULL(PrtQty,0)) AS float) AS prtQty
         FROM ${PRT()} GROUP BY SupplierAlias`
    ),
  ]);

  const soldBy = new Map(sales.map((r) => [r.SupplierAlias, r]));
  const prtBy = new Map(returns.map((r) => [r.SupplierAlias, num(r.prtQty)]));

  return purchases
    .map((p) => {
      const s = soldBy.get(p.SupplierAlias);
      const purQty = num(p.purQty);
      const prtQty = prtBy.get(p.SupplierAlias) || 0;
      const soldQty = num(s?.netQty);
      return {
        alias: p.SupplierAlias, name: p.SupplierName, city: p.SupplierCity,
        department: p.Department, articles: num(p.articles),
        purchasedQty: purQty, purchasedValue: num(p.purValue),
        returnedToSupplierQty: prtQty,
        soldQty, soldValue: num(s?.netValue),
        balanceQty: purQty - prtQty - soldQty,
        sellThroughPct: purQty - prtQty > 0
          ? Math.round((soldQty / (purQty - prtQty)) * 1000) / 10
          : null,
      };
    })
    .sort((a, b) => b.soldQty - a.soldQty)
    .slice(0, n);
}

export async function sizeMix({ from, to, supplierAlias = null }) {
  const filter = supplierAlias ? 'AND SupplierAlias = @alias' : '';
  const args = { from: D(isoDate(from)), to: D(isoDate(to)) };
  if (supplierAlias) args.alias = S(supplierAlias);
  return query(
    `SELECT SizeName,
            CAST(SUM(ISNULL(SLSQty,0)) - SUM(ISNULL(SLRQty,0)) AS float) AS netQty
       FROM ${SLS()}
      WHERE CashmemoDt >= @from AND CashmemoDt <= @to ${filter}
      GROUP BY SizeName
      ORDER BY netQty DESC`,
    args
  );
}

export async function departmentSplit({ from, to }) {
  return query(
    `SELECT DepartmentShortName AS department, CategoryShortName AS category,
            CAST(SUM(ISNULL(SLSQty,0)) - SUM(ISNULL(SLRQty,0)) AS float) AS netQty,
            CAST(SUM(ISNULL(SLSNetAmount,0)) - SUM(ISNULL(SLRNetAmount,0)) AS float) AS netValue
       FROM ${SLS()}
      WHERE CashmemoDt >= @from AND CashmemoDt <= @to
      GROUP BY DepartmentShortName, CategoryShortName
      ORDER BY netQty DESC`,
    { from: D(isoDate(from)), to: D(isoDate(to)) }
  );
}

export async function supplierDetail({ alias, from, to }) {
  const args = { alias: S(alias), from: D(isoDate(from)), to: D(isoDate(to)) };
  const [head, articles, colours, sizes, returns] = await Promise.all([
    query(
      `SELECT MAX(SupplierName) AS name, MAX(SupplierCity) AS city,
              CAST(SUM(ISNULL(PurQty,0)) AS float) AS purQty,
              CAST(SUM(ISNULL(PurNetAmount,0)) AS float) AS purValue,
              COUNT(DISTINCT ArticleNo) AS articles,
              MIN(PurchaseDt) AS firstPurchase, MAX(PurchaseDt) AS lastPurchase
         FROM ${PUR()} WHERE SupplierAlias = @alias`,
      { alias: args.alias }
    ),
    query(
      `SELECT TOP 200 ArticleNo,
              CAST(SUM(ISNULL(SLSQty,0)) - SUM(ISNULL(SLRQty,0)) AS float) AS netQty,
              CAST(SUM(ISNULL(SLSNetAmount,0)) - SUM(ISNULL(SLRNetAmount,0)) AS float) AS netValue
         FROM ${SLS()}
        WHERE SupplierAlias = @alias AND CashmemoDt >= @from AND CashmemoDt <= @to
        GROUP BY ArticleNo ORDER BY netQty DESC`,
      args
    ),
    query(
      `SELECT TOP 40 ColourName,
              CAST(SUM(ISNULL(SLSQty,0)) - SUM(ISNULL(SLRQty,0)) AS float) AS netQty
         FROM ${SLS()}
        WHERE SupplierAlias = @alias AND CashmemoDt >= @from AND CashmemoDt <= @to
        GROUP BY ColourName ORDER BY netQty DESC`,
      args
    ),
    sizeMix({ from, to, supplierAlias: alias }),
    query(
      `SELECT CAST(SUM(ISNULL(PrtQty,0)) AS float) AS qty,
              CAST(SUM(ISNULL(PrtNetAmount,0)) AS float) AS value
         FROM ${PRT()} WHERE SupplierAlias = @alias`,
      { alias: args.alias }
    ),
  ]);
  return { alias, head: head[0] || null, articles, colours, sizes, returns: returns[0] || null };
}

/* ---------------------------------------------------------- the open question */

/**
 * Reports the three quantity pairs together so the meaning of
 * SalesQuantity / SalesNetAmount can be settled from real data instead of
 * assumed. Run over a short period first - it scans the sales view.
 */
export async function reconcileSales({ from, to }) {
  const t = await salesTotals({ from, to });
  const netMatchesReported = Math.abs(t.reportedQty - t.netQty) < 1;
  const grossMatchesReported = Math.abs(t.reportedQty - t.grossQty) < 1;

  return {
    period: { from, to },
    sales_SLS: { qty: t.grossQty, value: t.grossValue },
    salesReturns_SLR: { qty: t.returnQty, value: t.returnValue },
    computedNet: { qty: t.netQty, value: t.netValue },
    reported_SalesQuantity: { qty: t.reportedQty, value: t.reportedValue },
    conclusion:
      netMatchesReported && grossMatchesReported
        ? 'There are no sales returns in this period, so the two readings cannot be told apart. Try a longer period.'
        : netMatchesReported
          ? 'SalesQuantity is already NET of returns - it equals SLSQty minus SLRQty.'
          : grossMatchesReported
            ? 'SalesQuantity is GROSS - it equals SLSQty and excludes returns.'
            : 'SalesQuantity matches neither reading. It may be scoped differently ' +
              '(a different date column, or rows this filter excludes). Worth asking whoever owns the view.',
    portalUses: 'SLSQty minus SLRQty, computed - never the reported pair.',
  };
}

/* ------------------------------------------------------------------ selftest */

function isUnreachable(err) {
  return /ETIMEOUT|ESOCKET|ECONNREFUSED|ENOTFOUND|Failed to connect|Login failed|timeout/i
    .test(String(err?.message || err));
}

/**
 * Runs every query above over a deliberately short window and reports which
 * worked, how long each took and one sample row - so the whole reporting
 * layer can be validated against the real server in a single call.
 *
 * Two guards, both learned the hard way. If the server cannot be reached it
 * stops after the first check rather than waiting out a connect timeout
 * thirteen times, which took over three minutes and would simply be killed
 * by the platform. And it works to a wall-clock budget, reporting what it
 * managed and what it did not reach, so a slow scan produces a partial
 * answer instead of no answer.
 */
export async function selftest({ from, to, budgetMs = Number(process.env.SELFTEST_BUDGET_MS || 40000) }) {
  const checks = [
    ['serverInfo', () => serverInfo()],
    ['salesTotals', () => salesTotals({ from, to })],
    ['purchaseTotals (period)', () => purchaseTotals({ from, to })],
    ['purchaseReturnTotals (period)', () => purchaseReturnTotals({ from, to })],
    ['dailySales', () => dailySales({ from, to })],
    ['bestSellers', () => bestSellers({ from, to, limit: 5 })],
    ['sizeMix', () => sizeMix({ from, to })],
    ['departmentSplit', () => departmentSplit({ from, to })],
    ['reconcileSales', () => reconcileSales({ from, to })],
    ['purchaseTotals (all time)', () => purchaseTotals()],
    ['purchaseReturnTotals (all time)', () => purchaseReturnTotals()],
    ['netSoldEver', () => netSoldEver()],
    ['supplierBook', () => supplierBook({ from, to, limit: 3 })],
  ];

  const results = [];
  const deadline = Date.now() + budgetMs;
  let stopped = null;

  for (const [name, fn] of checks) {
    if (stopped) {
      results.push({ check: name, ok: null, skipped: stopped });
      continue;
    }
    if (Date.now() > deadline) {
      stopped = 'the time budget ran out before this check';
      results.push({ check: name, ok: null, skipped: stopped });
      continue;
    }

    const started = Date.now();
    try {
      const value = await fn();
      results.push({
        check: name, ok: true, ms: Date.now() - started,
        rows: Array.isArray(value) ? value.length : 1,
        sample: Array.isArray(value) ? value[0] ?? null : value,
      });
    } catch (err) {
      const message = String(err.message || err);
      results.push({ check: name, ok: false, ms: Date.now() - started, error: message });
      if (isUnreachable(err)) {
        stopped = 'the server could not be reached, so the rest were not attempted';
      }
    }
  }

  const failed = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === null);
  return {
    period: { from, to },
    passed: results.filter((r) => r.ok === true).length,
    failed: failed.length,
    skipped: skipped.length,
    stoppedBecause: stopped,
    results,
  };
}

/* -------------------------------------------------------------- structure */

export async function serverInfo() {
  const rows = await query(
    `SELECT DB_NAME() AS [database], SUSER_SNAME() AS [login],
            SYSDATETIME() AS [serverTime], LEFT(@@VERSION, 110) AS [version]`
  );
  return rows[0];
}

export async function describeView(name) {
  const object = safeName(name);
  const columns = await query(
    `SELECT c.name AS [column], t.name AS [type], c.max_length AS [length], c.is_nullable AS [nullable]
       FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
      WHERE c.object_id = OBJECT_ID(@object) ORDER BY c.column_id`,
    { object: S(object) }
  );
  if (!columns.length) return { name: object, found: false };
  return {
    name: object, found: true, columnCount: columns.length,
    columns: columns.map((c) =>
      `${c.column} ${c.type}${c.length && String(c.type).includes('char') ? `(${c.length})` : ''}` +
      `${c.nullable ? '' : ' NOT NULL'}`),
  };
}

export async function describeViews() {
  const out = {};
  for (const [key, def] of Object.entries(VIEWS)) {
    try { out[key] = { ...def, ...(await describeView(def.name)) }; }
    catch (err) { out[key] = { ...def, found: false, error: String(err.message || err) }; }
  }
  return out;
}
