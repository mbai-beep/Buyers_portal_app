/**
 * The zRetailHQ0 reporting views behind the portal's figures.
 *
 * Four views, one shared grain. Every query is built from the declarations in
 * VIEWS and GRAIN below rather than written out by hand, so the set of
 * columns this app depends on is stated in one place and nothing can quietly
 * reach for a column that was not agreed.
 *
 * Nothing here writes. Every statement is a SELECT.
 *
 * Two things worth knowing:
 *
 * Stock comes from the inventory view, not arithmetic. An earlier version
 * derived it as purchased minus supplier returns minus sold-ever, because no
 * stock source had been identified; that was only ever as good as the views'
 * history was complete. BalQty is the real figure and replaces it.
 *
 * Columns are verified against the server before they are trusted. Two
 * different column lists have been supplied for these same views, so
 * verifyColumns() reads what is actually there and reports anything missing
 * by name - a clear answer instead of "Invalid column name" from a query.
 */
import { query, sql } from './sql.js';

/** The measures each view carries, and the column its dates live in. */
export const VIEWS = {
  purchases: {
    name: process.env.SQL_VIEW_PURCHASES || 'VW_MB_POWERBI_PUR_REPORT',
    what: 'Purchases - what was bought in',
    date: 'PurchaseDt', qty: 'PurQty', value: 'PurNetAmount',
  },
  purchaseReturns: {
    name: process.env.SQL_VIEW_PURCHASE_RETURNS || 'VW_MB_POWERBI_PRT_REPORT',
    what: 'Purchase returns - what went back to the supplier',
    date: 'PurReturnDt', qty: 'PrtQty', value: 'PrtNetAmount',
  },
  sales: {
    name: process.env.SQL_VIEW_SALES || 'VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID',
    what: 'Sales',
    date: 'CashmemoDt', qty: 'SalesQuantity', value: 'SalesNetAmount',
  },
  inventory: {
    name: process.env.SQL_VIEW_INVENTORY || 'VW_MB_AI_DSB_REPORT',
    what: 'Inventory - what is in stock now',
    date: null, qty: 'BalQty', value: 'BalCostValue',
  },
};

/** Dimensions common to all four views. */
export const GRAIN = {
  article: 'ArticleNo',
  category: 'CategoryShortName',
  fabric: 'FabricShortName',
  supplier: 'SupplierAlias',
};

/**
 * Reporting scans run with READ UNCOMMITTED by default: this is a live retail
 * database, and a full scan holding locks would sit in front of the tills.
 * The cost is that a figure can move by whatever is mid-transaction at that
 * instant. Set SQL_NOLOCK=false for strict reads.
 */
const HINT = process.env.SQL_NOLOCK === 'false' ? '' : ' WITH (NOLOCK)';

function safeName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(String(name))) {
    throw new Error(`unsafe object name: ${name}`);
  }
  return String(name);
}

function view(key) {
  const v = VIEWS[key];
  if (!v) throw new Error(`unknown view "${key}"`);
  return v;
}

const from_ = (key) => safeName(view(key).name) + HINT;

/** A dimension may only ever be one of the four declared in GRAIN. */
function dimension(name) {
  const column = GRAIN[name] || (Object.values(GRAIN).includes(name) ? name : null);
  if (!column) {
    throw new Error(`unknown dimension "${name}" - use one of ${Object.keys(GRAIN).join(', ')}`);
  }
  return column;
}

const D = (v) => ({ type: sql.Date, value: v });
const S = (v) => ({ type: sql.NVarChar, value: v });
const num = (v) => (v == null ? 0 : Number(v));

function topN(n, fallback = 50, max = 2000) {
  const i = Math.floor(Number(n));
  return Number.isFinite(i) && i >= 1 ? Math.min(i, max) : fallback;
}

/* ------------------------------------------------------------------ dates */

export function financialYearStart(on = new Date()) {
  const y = on.getUTCFullYear();
  return `${on.getUTCMonth() + 1 >= 4 ? y : y - 1}-04-01`;   // April to March
}

export function isoDate(v) {
  const s = String(v ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`expected a YYYY-MM-DD date, got "${s}"`);
  return s;
}

function period(key, { from, to }) {
  const v = view(key);
  if (!v.date) return { where: '', args: {} };
  return {
    where: `WHERE ${v.date} >= @from AND ${v.date} <= @to`,
    args: { from: D(isoDate(from)), to: D(isoDate(to)) },
  };
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

/* ------------------------------------------------------------------ totals */

/** Quantity and value for one view, optionally over a period. */
export async function totals(key, range = null) {
  const v = view(key);
  const { where, args } = range ? period(key, range) : { where: '', args: {} };
  const rows = await query(
    `SELECT CAST(SUM(ISNULL(${v.qty}, 0))   AS float) AS qty,
            CAST(SUM(ISNULL(${v.value}, 0)) AS float) AS value,
            COUNT(DISTINCT ${GRAIN.article})          AS articles,
            COUNT(DISTINCT ${GRAIN.supplier})         AS suppliers,
            COUNT(DISTINCT ${GRAIN.category})         AS categories,
            COUNT(DISTINCT ${GRAIN.fabric})           AS fabrics,
            COUNT_BIG(*)                              AS rows
       FROM ${from_(key)} ${where}`,
    args
  );
  const r = rows[0] || {};
  return {
    view: v.name, qty: num(r.qty), value: num(r.value),
    articles: num(r.articles), suppliers: num(r.suppliers),
    categories: num(r.categories), fabrics: num(r.fabrics),
    rows: num(r.rows),
  };
}

/** One view, grouped by one dimension. */
export async function groupBy(key, dim, { from, to, limit = 50, order = 'value' } = {}) {
  const v = view(key);
  const column = dimension(dim);
  const n = topN(limit, 50);
  const { where, args } = v.date && from && to ? period(key, { from, to }) : { where: '', args: {} };
  const orderBy = order === 'qty' ? 'qty' : 'value';

  const rows = await query(
    `SELECT TOP ${n} ${column} AS [key],
            CAST(SUM(ISNULL(${v.qty}, 0))   AS float) AS qty,
            CAST(SUM(ISNULL(${v.value}, 0)) AS float) AS value,
            COUNT(DISTINCT ${GRAIN.article})          AS articles
       FROM ${from_(key)} ${where}
      GROUP BY ${column}
      ORDER BY ${orderBy} DESC`,
    args
  );
  return rows.map((r) => ({
    key: r.key, qty: num(r.qty), value: num(r.value), articles: num(r.articles),
  }));
}

/** A daily series for a dated view. */
export async function daily(key, { from, to }) {
  const v = view(key);
  if (!v.date) throw new Error(`${key} has no date column, so it has no daily series`);
  const { where, args } = period(key, { from, to });
  const rows = await query(
    `SELECT ${v.date} AS d,
            CAST(SUM(ISNULL(${v.qty}, 0))   AS float) AS qty,
            CAST(SUM(ISNULL(${v.value}, 0)) AS float) AS value
       FROM ${from_(key)} ${where}
      GROUP BY ${v.date}
      ORDER BY ${v.date}`,
    args
  );
  return rows.map((r) => ({
    date: r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10),
    qty: num(r.qty), value: num(r.value),
  }));
}

/* -------------------------------------------------------------- home tiles */

export async function homeTotals({ from, to }) {
  return cached(`home:${from}:${to}:${HINT}`, async () => {
    const fyFrom = financialYearStart(new Date(`${to}T00:00:00Z`));
    const [sold, soldFy, purchased, purchasedFy, purchasedEver, returned, stock] = await Promise.all([
      totals('sales', { from, to }),
      totals('sales', { from: fyFrom, to }),
      totals('purchases', { from, to }),
      totals('purchases', { from: fyFrom, to }),
      totals('purchases'),               // all time: the book, not a period
      totals('purchaseReturns', { from, to }),
      totals('inventory'),
    ]);

    return {
      period: { from, to },
      financialYearFrom: fyFrom,
      sold: { qty: sold.qty, value: sold.value, articles: sold.articles, suppliers: sold.suppliers },
      soldThisYear: { qty: soldFy.qty, value: soldFy.value },
      purchased: { qty: purchased.qty, value: purchased.value, articles: purchased.articles },
      purchasedThisYear: { qty: purchasedFy.qty, value: purchasedFy.value, articles: purchasedFy.articles },
      returnedToSuppliers: { qty: returned.qty, value: returned.value },
      // Read from the inventory view, not derived from the other three.
      withUs: { qty: stock.qty, costValue: stock.value, articles: stock.articles, source: stock.view },

      /*
       * Counts of distinct SupplierAlias and ArticleNo depend entirely on
       * which view and which window you count over, so each basis is named
       * rather than left to be inferred from a tile label.
       */
      suppliers: {
        withStockNow: stock.suppliers,
        boughtFromEver: purchasedEver.suppliers,
        boughtFromThisYear: purchasedFy.suppliers,
        soldInPeriod: sold.suppliers,
      },
      designs: {
        inStockNow: stock.articles,
        boughtEver: purchasedEver.articles,
        boughtThisYear: purchasedFy.articles,
        soldInPeriod: sold.articles,
      },
      purchasedEver: { qty: purchasedEver.qty, value: purchasedEver.value },
    };
  });
}

/* ------------------------------------------------------------ leader boards */

/**
 * Best sellers, with stock beside each line - the two numbers a buyer reads
 * together. Sales and inventory are queried separately and merged here rather
 * than joined in SQL, which keeps each scan simple and lets an article that
 * sold but is now out of stock still appear.
 */
export async function articleLeaders({ from, to, limit = 50 }) {
  const n = topN(limit, 50);
  const [sold, stock] = await Promise.all([
    query(
      `SELECT TOP ${n} ${GRAIN.article} AS article,
              MAX(${GRAIN.category}) AS category,
              MAX(${GRAIN.fabric})   AS fabric,
              MAX(${GRAIN.supplier}) AS supplier,
              CAST(SUM(ISNULL(SalesQuantity, 0))  AS float) AS soldQty,
              CAST(SUM(ISNULL(SalesNetAmount, 0)) AS float) AS soldValue
         FROM ${from_('sales')}
        WHERE CashmemoDt >= @from AND CashmemoDt <= @to
        GROUP BY ${GRAIN.article}
        ORDER BY soldQty DESC`,
      { from: D(isoDate(from)), to: D(isoDate(to)) }
    ),
    query(
      `SELECT ${GRAIN.article} AS article,
              CAST(SUM(ISNULL(BalQty, 0))       AS float) AS balQty,
              CAST(SUM(ISNULL(BalCostValue, 0)) AS float) AS balValue
         FROM ${from_('inventory')}
        GROUP BY ${GRAIN.article}`
    ),
  ]);

  const stockBy = new Map(stock.map((r) => [r.article, r]));
  return sold.map((r) => {
    const s = stockBy.get(r.article);
    const soldQty = num(r.soldQty);
    const balQty = num(s?.balQty);
    return {
      article: r.article, category: r.category, fabric: r.fabric, supplier: r.supplier,
      soldQty, soldValue: num(r.soldValue),
      balanceQty: balQty, balanceCostValue: num(s?.balValue),
      inStock: Boolean(s),
      // Of what was available in the period, how much moved.
      sellThroughPct: soldQty + balQty > 0
        ? Math.round((soldQty / (soldQty + balQty)) * 1000) / 10
        : null,
      weeksOfCover: soldQty > 0 ? Math.round((balQty / soldQty) * 10) / 10 : null,
    };
  });
}

/** The book: every supplier, with what was bought, returned, sold and held. */
export async function supplierBook({ from, to, limit = 500 }) {
  const n = topN(limit, 500, 5000);
  const [purchased, returned, sold, stock] = await Promise.all([
    groupBy('purchases', 'supplier', { from, to, limit: 5000 }),
    groupBy('purchaseReturns', 'supplier', { from, to, limit: 5000 }),
    groupBy('sales', 'supplier', { from, to, limit: 5000 }),
    groupBy('inventory', 'supplier', { limit: 5000 }),
  ]);

  const index = new Map();
  const put = (rows, field) => {
    for (const r of rows) {
      if (!index.has(r.key)) {
        index.set(r.key, {
          alias: r.key, purchasedQty: 0, purchasedValue: 0, returnedQty: 0, returnedValue: 0,
          soldQty: 0, soldValue: 0, balanceQty: 0, balanceCostValue: 0, articlesInStock: 0,
        });
      }
      const row = index.get(r.key);
      row[`${field}Qty`] = r.qty;
      row[`${field}Value`] = r.value;
      if (field === 'balance') {
        row.balanceCostValue = r.value;
        row.articlesInStock = r.articles;
      }
    }
  };
  put(purchased, 'purchased');
  put(returned, 'returned');
  put(sold, 'sold');
  put(stock, 'balance');

  return [...index.values()]
    .map((r) => ({
      ...r,
      sellThroughPct: r.soldQty + r.balanceQty > 0
        ? Math.round((r.soldQty / (r.soldQty + r.balanceQty)) * 1000) / 10
        : null,
    }))
    .sort((a, b) => b.soldQty - a.soldQty)
    .slice(0, n);
}

/** One supplier, across all four views. */
export async function supplierDetail({ alias, from, to }) {
  const a = String(alias || '').trim();
  if (!a) throw new Error('a supplier alias is required');
  const args = { alias: S(a), from: D(isoDate(from)), to: D(isoDate(to)) };

  const one = async (key, range) => {
    const v = view(key);
    const dateWhere = v.date && range ? `AND ${v.date} >= @from AND ${v.date} <= @to` : '';
    const rows = await query(
      `SELECT CAST(SUM(ISNULL(${v.qty}, 0))   AS float) AS qty,
              CAST(SUM(ISNULL(${v.value}, 0)) AS float) AS value,
              COUNT(DISTINCT ${GRAIN.article})          AS articles
         FROM ${from_(key)}
        WHERE ${GRAIN.supplier} = @alias ${dateWhere}`,
      v.date && range ? args : { alias: args.alias }
    );
    const r = rows[0] || {};
    return { qty: num(r.qty), value: num(r.value), articles: num(r.articles) };
  };

  const [purchased, returned, sold, stock, articles, categories, fabrics] = await Promise.all([
    one('purchases', true), one('purchaseReturns', true), one('sales', true), one('inventory', false),
    query(
      `SELECT TOP 200 ${GRAIN.article} AS article,
              MAX(${GRAIN.category}) AS category, MAX(${GRAIN.fabric}) AS fabric,
              CAST(SUM(ISNULL(SalesQuantity, 0))  AS float) AS soldQty,
              CAST(SUM(ISNULL(SalesNetAmount, 0)) AS float) AS soldValue
         FROM ${from_('sales')}
        WHERE ${GRAIN.supplier} = @alias AND CashmemoDt >= @from AND CashmemoDt <= @to
        GROUP BY ${GRAIN.article} ORDER BY soldQty DESC`,
      args
    ),
    query(
      `SELECT ${GRAIN.category} AS [key],
              CAST(SUM(ISNULL(SalesQuantity, 0)) AS float) AS qty,
              CAST(SUM(ISNULL(SalesNetAmount,0)) AS float) AS value
         FROM ${from_('sales')}
        WHERE ${GRAIN.supplier} = @alias AND CashmemoDt >= @from AND CashmemoDt <= @to
        GROUP BY ${GRAIN.category} ORDER BY qty DESC`,
      args
    ),
    query(
      `SELECT ${GRAIN.fabric} AS [key],
              CAST(SUM(ISNULL(SalesQuantity, 0)) AS float) AS qty,
              CAST(SUM(ISNULL(SalesNetAmount,0)) AS float) AS value
         FROM ${from_('sales')}
        WHERE ${GRAIN.supplier} = @alias AND CashmemoDt >= @from AND CashmemoDt <= @to
        GROUP BY ${GRAIN.fabric} ORDER BY qty DESC`,
      args
    ),
  ]);

  return {
    alias: a,
    purchased, returnedToSupplier: returned, sold, inStock: stock,
    sellThroughPct: sold.qty + stock.qty > 0
      ? Math.round((sold.qty / (sold.qty + stock.qty)) * 1000) / 10
      : null,
    articles: articles.map((r) => ({
      article: r.article, category: r.category, fabric: r.fabric,
      soldQty: num(r.soldQty), soldValue: num(r.soldValue),
    })),
    categories: categories.map((r) => ({ key: r.key, qty: num(r.qty), value: num(r.value) })),
    fabrics: fabrics.map((r) => ({ key: r.key, qty: num(r.qty), value: num(r.value) })),
  };
}

/* -------------------------------------------------------- column verification */

/** Every column this app reads, per view. */
export function requiredColumns() {
  const out = {};
  for (const [key, v] of Object.entries(VIEWS)) {
    out[key] = {
      view: v.name,
      columns: [...(v.date ? [v.date] : []), v.qty, v.value, ...Object.values(GRAIN)],
    };
  }
  return out;
}

export async function describeView(name) {
  const object = safeName(name);
  const columns = await query(
    `SELECT c.name AS [column], t.name AS [type], c.is_nullable AS [nullable]
       FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
      WHERE c.object_id = OBJECT_ID(@object) ORDER BY c.column_id`,
    { object: S(object) }
  );
  if (!columns.length) return { name: object, found: false };
  return {
    name: object, found: true, columnCount: columns.length,
    columns: columns.map((c) => `${c.column} ${c.type}${c.nullable ? '' : ' NOT NULL'}`),
    names: columns.map((c) => String(c.column)),
  };
}

/**
 * Checks the server actually has every column the app reads, and names what
 * is missing. Two different column lists have been supplied for these views,
 * so this is the difference between a clear answer and "Invalid column name".
 */
export async function verifyColumns() {
  const required = requiredColumns();
  const report = {};
  let ok = true;

  for (const [key, need] of Object.entries(required)) {
    let described;
    try { described = await describeView(need.view); }
    catch (err) { report[key] = { view: need.view, ok: false, error: String(err.message || err) }; ok = false; continue; }

    if (!described.found) {
      report[key] = { view: need.view, ok: false, problem: 'view not found or not visible to this login' };
      ok = false;
      continue;
    }
    const have = new Set(described.names);
    const missing = need.columns.filter((c) => !have.has(c));
    report[key] = {
      view: need.view, ok: missing.length === 0,
      uses: need.columns, missing,
      alsoAvailable: described.names.filter((c) => !need.columns.includes(c)).slice(0, 40),
    };
    if (missing.length) ok = false;
  }
  return { ok, views: report };
}

export async function describeViews() {
  const out = {};
  for (const [key, v] of Object.entries(VIEWS)) {
    try { out[key] = { ...v, ...(await describeView(v.name)) }; }
    catch (err) { out[key] = { ...v, found: false, error: String(err.message || err) }; }
  }
  return out;
}

export async function serverInfo() {
  const rows = await query(
    `SELECT DB_NAME() AS [database], SUSER_SNAME() AS [login],
            SYSDATETIME() AS [serverTime], LEFT(@@VERSION, 110) AS [version]`
  );
  return rows[0];
}

/* ------------------------------------------------------------------ selftest */

function isUnreachable(err) {
  return /ETIMEOUT|ESOCKET|ECONNREFUSED|ENOTFOUND|Failed to connect|Login failed|timeout/i
    .test(String(err?.message || err));
}

/**
 * Runs every query over a short window and reports which worked, how long
 * each took and a sample row - the whole layer validated against the real
 * server in one call.
 *
 * It stops at the first connection failure rather than waiting out a connect
 * timeout for every check, and works to a wall-clock budget, so a slow scan
 * gives a partial answer instead of being killed by the platform.
 */
export async function selftest({ from, to, budgetMs = Number(process.env.SELFTEST_BUDGET_MS || 40000) }) {
  const checks = [
    ['serverInfo', () => serverInfo()],
    ['verifyColumns', () => verifyColumns()],
    ['totals: sales (period)', () => totals('sales', { from, to })],
    ['totals: purchases (period)', () => totals('purchases', { from, to })],
    ['totals: purchase returns (period)', () => totals('purchaseReturns', { from, to })],
    ['totals: inventory (now)', () => totals('inventory')],
    ['daily: sales', () => daily('sales', { from, to })],
    ['groupBy: sales by category', () => groupBy('sales', 'category', { from, to, limit: 5 })],
    ['groupBy: sales by fabric', () => groupBy('sales', 'fabric', { from, to, limit: 5 })],
    ['groupBy: inventory by supplier', () => groupBy('inventory', 'supplier', { limit: 5 })],
    ['articleLeaders', () => articleLeaders({ from, to, limit: 5 })],
    ['supplierBook', () => supplierBook({ from, to, limit: 5 })],
    ['homeTotals', () => homeTotals({ from, to })],
  ];

  const results = [];
  const deadline = Date.now() + budgetMs;
  let stopped = null;

  for (const [name, fn] of checks) {
    if (stopped) { results.push({ check: name, ok: null, skipped: stopped }); continue; }
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
      results.push({ check: name, ok: false, ms: Date.now() - started, error: String(err.message || err) });
      if (isUnreachable(err)) stopped = 'the server could not be reached, so the rest were not attempted';
    }
  }

  return {
    period: { from, to },
    passed: results.filter((r) => r.ok === true).length,
    failed: results.filter((r) => r.ok === false).length,
    skipped: results.filter((r) => r.ok === null).length,
    stoppedBecause: stopped,
    results,
  };
}
