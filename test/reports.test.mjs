/**
 * The reporting layer, tested without a SQL Server.
 *
 * zRetailHQ0 is not reachable from a test runner, so lib/sql.js is mocked and
 * the assertions cover what this code is responsible for: that every query is
 * built only from the agreed columns, that dates and aliases are bound rather
 * than interpolated, the period maths, the merges, and the selftest guards.
 * Whether the server accepts the SQL is answered by /api/reports/selftest.
 *
 *   npm test
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET = 'test-secret-at-least-thirty-two-characters-long';
process.env.REPORT_TODAY = '2026-09-02';
process.env.REPORT_CACHE_SECONDS = '0';

let issued = [];
let responder = () => [];

mock.module('../lib/sql.js', {
  namedExports: {
    query: async (text, params = {}) => {
      issued.push({ text: text.replace(/\s+/g, ' ').trim(), params });
      return responder(text, params);
    },
    sql: { Date: 'Date', NVarChar: 'NVarChar', Int: 'Int' },
    pool: async () => ({ close() {} }),
  },
});

const reports = await import('../lib/reports.js');
const { resolvePeriod } = await import('../lib/period.js');

beforeEach(() => { issued = []; responder = () => []; reports.clearCache(); });

/** Exactly the columns the four views were specified with. */
const ALLOWED = new Set([
  'PurchaseDt', 'PurQty', 'PurNetAmount',
  'PurReturnDt', 'PrtQty', 'PrtNetAmount',
  'CashmemoDt', 'SalesQuantity', 'SalesNetAmount',
  'BalQty', 'BalCostValue',
  'ArticleNo', 'CategoryShortName', 'FabricShortName', 'SupplierAlias',
]);

/** Columns that exist in the database but are outside the agreed set. */
const OFF_SPEC = [
  'SLSQty', 'SLRQty', 'SLSNetAmount', 'SLRNetAmount', 'ColourName', 'SizeName',
  'SupplierName', 'SupplierCity', 'BranchAlias', 'ItemMRP', 'ItemId',
  'DepartmentShortName', 'CashmemoNo', 'PurInvoiceNo', 'PurchasePrice',
  'Para1Name', 'Para2Name', 'Fabric', 'SubFabric', 'Concept', 'CustomerName',
];

/* --------------------------------------------- only the agreed columns, ever */

test('no query reaches for a column outside the four-view spec', async () => {
  responder = () => [{}];
  await Promise.all([
    reports.totals('sales', { from: '2026-08-01', to: '2026-08-31' }),
    reports.totals('purchases', { from: '2026-08-01', to: '2026-08-31' }),
    reports.totals('purchaseReturns', { from: '2026-08-01', to: '2026-08-31' }),
    reports.totals('inventory'),
    reports.daily('sales', { from: '2026-08-01', to: '2026-08-31' }),
    reports.groupBy('sales', 'category', { from: '2026-08-01', to: '2026-08-31' }),
    reports.groupBy('inventory', 'supplier', {}),
    reports.articleLeaders({ from: '2026-08-01', to: '2026-08-31', limit: 5 }),
    reports.supplierBook({ from: '2026-08-01', to: '2026-08-31' }),
    reports.supplierDetail({ alias: 'AHD-NIC', from: '2026-08-01', to: '2026-08-31' }),
    reports.homeTotals({ from: '2026-08-01', to: '2026-08-31' }),
  ]);

  assert.ok(issued.length > 20, `expected many queries, saw ${issued.length}`);
  for (const q of issued) {
    for (const column of OFF_SPEC) {
      assert.ok(
        !new RegExp(`\\b${column}\\b`).test(q.text),
        `"${column}" is outside the agreed columns but appears in: ${q.text.slice(0, 120)}`
      );
    }
  }
});

test('sales uses SalesQuantity, not the SLS/SLR pair', async () => {
  responder = () => [{}];
  await reports.totals('sales', { from: '2026-08-01', to: '2026-08-31' });
  assert.match(issued[0].text, /SUM\(ISNULL\(SalesQuantity, 0\)\)/);
  assert.match(issued[0].text, /SUM\(ISNULL\(SalesNetAmount, 0\)\)/);
  assert.ok(!/SLSQty|SLRQty/.test(issued[0].text));
});

test('each view is read with its own date and measure columns', async () => {
  responder = () => [{}];
  const expected = {
    purchases: [/VW_MB_POWERBI_PUR_REPORT/, /PurchaseDt >= @from/, /PurQty/, /PurNetAmount/],
    purchaseReturns: [/VW_MB_POWERBI_PRT_REPORT/, /PurReturnDt >= @from/, /PrtQty/, /PrtNetAmount/],
    sales: [/VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID/, /CashmemoDt >= @from/, /SalesQuantity/, /SalesNetAmount/],
  };
  for (const [key, patterns] of Object.entries(expected)) {
    issued = [];
    await reports.totals(key, { from: '2026-08-01', to: '2026-08-31' });
    for (const p of patterns) assert.match(issued[0].text, p, `${key}: ${p}`);
  }
});

test('inventory has no date column, so it is never filtered by one', async () => {
  responder = () => [{}];
  await reports.totals('inventory');
  assert.match(issued[0].text, /VW_MB_AI_DSB_REPORT/);
  assert.match(issued[0].text, /BalQty/);
  assert.match(issued[0].text, /BalCostValue/);
  assert.ok(!/WHERE/.test(issued[0].text), 'no period filter on a view without dates');
  await assert.rejects(() => reports.daily('inventory', { from: '2026-08-01', to: '2026-08-02' }),
    /no date column/);
});

/* -------------------------------------------------------- nothing interpolated */

test('dates and aliases are bound as parameters', async () => {
  responder = () => [{}];
  await reports.supplierDetail({ alias: "AHD'; DROP TABLE x--", from: '2026-08-01', to: '2026-08-31' });
  for (const q of issued) {
    assert.ok(!q.text.includes('2026-08-01'), 'no date in the SQL text');
    assert.ok(!q.text.includes('DROP'), 'no alias in the SQL text');
  }
  assert.equal(issued[0].params.alias.value, "AHD'; DROP TABLE x--");
});

test('a dimension must be one of the four, not free text', async () => {
  responder = () => [];
  await assert.rejects(() => reports.groupBy('sales', 'CustomerName', {}), /unknown dimension/);
  await assert.rejects(() => reports.groupBy('sales', '1; DROP TABLE x', {}), /unknown dimension/);
  for (const d of ['article', 'category', 'fabric', 'supplier']) {
    issued = [];
    await reports.groupBy('sales', d, { from: '2026-08-01', to: '2026-08-31' });
    assert.match(issued[0].text, /GROUP BY (ArticleNo|CategoryShortName|FabricShortName|SupplierAlias)/);
  }
});

test('an unknown view is refused', async () => {
  await assert.rejects(() => reports.totals('ledger'), /unknown view "ledger"/);
});

test('a renamed view is validated before it reaches a statement', async () => {
  const original = process.env.SQL_VIEW_INVENTORY;
  process.env.SQL_VIEW_INVENTORY = 'VW_X; DROP TABLE Stock--';
  const fresh = await import(`../lib/reports.js?evil=${Date.now()}`);
  await assert.rejects(() => fresh.totals('inventory'), /unsafe object name/);
  if (original === undefined) delete process.env.SQL_VIEW_INVENTORY;
  else process.env.SQL_VIEW_INVENTORY = original;
});

test('a row limit can only ever be a bounded integer', async () => {
  responder = () => [];
  for (const [given, expected] of [['5', 5], ['abc', 50], ['-3', 50], ['999999', 2000],
                                   ['10; DROP TABLE x', 50], ['7.9', 7]]) {
    issued = [];
    await reports.groupBy('sales', 'article', { from: '2026-08-01', to: '2026-08-31', limit: given });
    assert.match(issued[0].text, new RegExp(`SELECT TOP ${expected}\\b`), `limit ${given}`);
  }
});

test('reads are hinted so a scan cannot sit in front of the tills', async () => {
  responder = () => [{}];
  await reports.totals('sales', { from: '2026-08-01', to: '2026-08-31' });
  assert.match(issued[0].text, /WITH \(NOLOCK\)/);
});

/* ------------------------------------------------------------- period maths */

test('periods resolve against a fixed today', () => {
  assert.deepEqual(resolvePeriod({ period: 'd1' }), { from: '2026-09-02', to: '2026-09-02', label: 'today' });
  assert.equal(resolvePeriod({ period: 'd7' }).from, '2026-08-27');
  assert.equal(resolvePeriod({ period: 'd30' }).from, '2026-08-04');
  assert.equal(resolvePeriod({ period: 'mtd' }).from, '2026-09-01');
  assert.equal(resolvePeriod({ period: 'fy' }).from, '2026-04-01', 'Indian FY starts 1 April');
});

test('a financial year before April belongs to the previous year', () => {
  assert.equal(reports.financialYearStart(new Date('2026-03-31T00:00:00Z')), '2025-04-01');
  assert.equal(reports.financialYearStart(new Date('2026-04-01T00:00:00Z')), '2026-04-01');
});

test('bad periods and dates are refused, not coerced', () => {
  assert.throws(() => resolvePeriod({ period: 'last-tuesday' }), /unknown period/);
  assert.throws(() => resolvePeriod({ from: '2026-12-01', to: '2026-01-01' }), /after/);
  assert.throws(() => reports.isoDate("2026-01-01'; DROP TABLE x--"), /YYYY-MM-DD/);
});

/* --------------------------------------------------------------- home tiles */

test('stock is read from the inventory view, not derived', async () => {
  responder = (text) => {
    const t = text.replace(/\s+/g, ' ');
    if (/VW_MB_AI_DSB_REPORT/.test(t)) return [{ qty: 252186, value: 187000000, articles: 12090, suppliers: 225 }];
    if (/VW_MB_POWERBI_PUR_REPORT/.test(t)) return [{ qty: 500000, value: 4e8, articles: 9000, suppliers: 220 }];
    if (/VW_MB_POWERBI_PRT_REPORT/.test(t)) return [{ qty: 4000, value: 3e6, articles: 300 }];
    return [{ qty: 108498, value: 9e7, articles: 3400, suppliers: 190 }];
  };
  const h = await reports.homeTotals({ from: '2026-08-04', to: '2026-09-02' });

  assert.equal(h.withUs.qty, 252186, 'straight from BalQty');
  assert.equal(h.withUs.costValue, 187000000);
  assert.equal(h.withUs.source, 'VW_MB_AI_DSB_REPORT');

  // Each count says which view and window it came from: the same question
  // ("how many suppliers?") has four defensible answers.
  assert.equal(h.designs.inStockNow, 12090);
  assert.equal(h.suppliers.withStockNow, 225);
  assert.equal(h.suppliers.boughtFromEver, 220);
  assert.equal(h.designs.boughtEver, 9000);
  assert.equal(h.sold.qty, 108498);
  assert.equal(h.returnedToSuppliers.qty, 4000);
  assert.equal(h.financialYearFrom, '2026-04-01');
});

/* ---------------------------------------------------------------- the merges */

test('best sellers carry stock beside sales, and survive being out of stock', async () => {
  responder = (text) => {
    if (/VW_MB_AI_DSB_REPORT/.test(text)) return [{ article: 'A1', balQty: 40, balValue: 20000 }];
    return [
      { article: 'A1', category: 'SP', fabric: 'COTTON', supplier: 'AHD-NIC', soldQty: 60, soldValue: 42000 },
      { article: 'A2', category: 'RM', fabric: 'RAYON', supplier: 'JPR-FLW', soldQty: 30, soldValue: 21000 },
    ];
  };
  const rows = await reports.articleLeaders({ from: '2026-08-01', to: '2026-08-31' });

  const a1 = rows.find((r) => r.article === 'A1');
  assert.equal(a1.balanceQty, 40);
  assert.equal(a1.inStock, true);
  assert.equal(a1.sellThroughPct, 60, '60 of the 100 that existed');
  assert.equal(a1.weeksOfCover, 0.7);

  const a2 = rows.find((r) => r.article === 'A2');
  assert.equal(a2.balanceQty, 0);
  assert.equal(a2.inStock, false, 'sold but no longer stocked - still listed');
  assert.equal(a2.sellThroughPct, 100);
});

test('the book merges all four views per supplier', async () => {
  responder = (text) => {
    const t = text.replace(/\s+/g, ' ');
    if (/VW_MB_POWERBI_PUR_REPORT/.test(t)) return [
      { key: 'AHD-NIC', qty: 1000, value: 500000, articles: 40 },
      { key: 'OLD-SUP', qty: 300, value: 90000, articles: 10 },
    ];
    if (/VW_MB_POWERBI_PRT_REPORT/.test(t)) return [{ key: 'AHD-NIC', qty: 100, value: 50000, articles: 5 }];
    if (/VW_MB_AI_DSB_REPORT/.test(t)) return [
      { key: 'AHD-NIC', qty: 250, value: 130000, articles: 22 },
      { key: 'NEW-SUP', qty: 90, value: 40000, articles: 6 },
    ];
    return [{ key: 'AHD-NIC', qty: 650, value: 455000, articles: 35 }];
  };
  const book = await reports.supplierBook({ from: '2026-04-01', to: '2026-09-02' });

  const nic = book.find((b) => b.alias === 'AHD-NIC');
  assert.equal(nic.purchasedQty, 1000);
  assert.equal(nic.returnedQty, 100);
  assert.equal(nic.soldQty, 650);
  assert.equal(nic.balanceQty, 250, 'from inventory, not purchases minus sales');
  assert.equal(nic.balanceCostValue, 130000);
  assert.equal(nic.sellThroughPct, 72.2);

  // A supplier present in only one view must still appear.
  assert.ok(book.find((b) => b.alias === 'NEW-SUP'), 'stock but no purchases in period');
  assert.ok(book.find((b) => b.alias === 'OLD-SUP'), 'purchases but no stock');
  assert.equal(book.find((b) => b.alias === 'OLD-SUP').balanceQty, 0);
});

test('sell-through is null rather than a divide by zero', async () => {
  responder = (text) => (/VW_MB_POWERBI_PUR_REPORT/.test(text)
    ? [{ key: 'X', qty: 0, value: 0, articles: 0 }] : []);
  const book = await reports.supplierBook({ from: '2026-04-01', to: '2026-09-02' });
  assert.equal(book[0].sellThroughPct, null);
});

test('daily sales come back as plain ISO dates', async () => {
  responder = () => [
    { d: new Date('2026-08-30T00:00:00Z'), qty: 250, value: 120000 },
    { d: '2026-08-31', qty: 300, value: 150000 },
  ];
  const days = await reports.daily('sales', { from: '2026-08-30', to: '2026-08-31' });
  assert.deepEqual(days.map((d) => d.date), ['2026-08-30', '2026-08-31']);
  assert.equal(days[0].qty, 250);
});

/* ------------------------------------------------------ column verification */

test('the required column set is exactly the agreed one', () => {
  const req = reports.requiredColumns();
  assert.deepEqual(Object.keys(req).sort(), ['inventory', 'purchaseReturns', 'purchases', 'sales']);
  for (const [key, spec] of Object.entries(req)) {
    for (const column of spec.columns) {
      assert.ok(ALLOWED.has(column), `${key} asks for "${column}", which is outside the spec`);
    }
  }
  assert.deepEqual(req.inventory.columns,
    ['BalQty', 'BalCostValue', 'ArticleNo', 'CategoryShortName', 'FabricShortName', 'SupplierAlias']);
});

test('verifyColumns names a missing column instead of letting a query fail', async () => {
  responder = (text, params) => {
    if (!/sys\.columns/.test(text)) return [{}];
    const base = ['ArticleNo', 'CategoryShortName', 'SupplierAlias'];   // FabricShortName absent
    const extra = {
      'VW_MB_POWERBI_PUR_REPORT': ['PurchaseDt', 'PurQty', 'PurNetAmount'],
      'VW_MB_POWERBI_PRT_REPORT': ['PurReturnDt', 'PrtQty', 'PrtNetAmount'],
      'VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID': ['CashmemoDt', 'SalesQuantity', 'SalesNetAmount'],
      'VW_MB_AI_DSB_REPORT': ['BalQty', 'BalCostValue'],
    }[params.object.value] || [];
    return [...base, ...extra].map((c) => ({ column: c, type: 'varchar', nullable: 0 }));
  };
  const v = await reports.verifyColumns();
  assert.equal(v.ok, false);
  for (const key of ['purchases', 'purchaseReturns', 'sales', 'inventory']) {
    assert.deepEqual(v.views[key].missing, ['FabricShortName'], `${key} should name the missing column`);
  }
});

test('verifyColumns passes when every column is present', async () => {
  responder = (text, params) => {
    if (!/sys\.columns/.test(text)) return [{}];
    const req = reports.requiredColumns();
    const spec = Object.values(req).find((r) => r.view === params.object.value);
    return (spec?.columns || []).map((c) => ({ column: c, type: 'numeric', nullable: 0 }));
  };
  const v = await reports.verifyColumns();
  assert.equal(v.ok, true);
  assert.equal(v.views.sales.missing.length, 0);
});

test('verifyColumns reports a view that is not visible to this login', async () => {
  responder = (text) => (/sys\.columns/.test(text) ? [] : [{}]);
  const v = await reports.verifyColumns();
  assert.equal(v.ok, false);
  assert.match(v.views.inventory.problem, /not found or not visible/);
});

/* ------------------------------------------------------------------ selftest */

test('selftest reports each query rather than failing on the first', async () => {
  // Targeted at the daily series specifically. Counting calls would land
  // inside verifyColumns, which catches per-view errors itself and reports
  // them as a missing column rather than throwing - so the injection has to
  // name the query it means.
  responder = (text) => {
    if (/GROUP BY CashmemoDt/.test(text.replace(/\s+/g, ' '))) {
      throw new Error('Invalid column name "Nope"');
    }
    return [{}];
  };
  const r = await reports.selftest({ from: '2026-08-26', to: '2026-09-02' });
  assert.equal(r.failed, 1, 'one check failed, the rest carried on');
  assert.ok(r.passed > 8);
  const broken = r.results.find((x) => x.ok === false);
  assert.equal(broken.check, 'daily: sales');
  assert.match(broken.error, /Invalid column name/);
  assert.equal(r.stoppedBecause, null, 'a bad column is not a connection failure');
});

test('selftest stops at once when the server cannot be reached', async () => {
  let attempts = 0;
  responder = () => { attempts++; throw new Error('Failed to connect to 38.45.94.39:12866 in 8000ms'); };
  const r = await reports.selftest({ from: '2026-08-26', to: '2026-09-02' });
  assert.equal(attempts, 1, 'only the first check should be attempted');
  assert.ok(r.skipped > 10);
  assert.match(r.stoppedBecause, /could not be reached/);
});

test('selftest works to a budget so a slow scan still answers', async () => {
  responder = async () => { await new Promise((r) => setTimeout(r, 30)); return [{}]; };
  const r = await reports.selftest({ from: '2026-08-26', to: '2026-09-02', budgetMs: 60 });
  assert.ok(r.passed >= 1 && r.passed < 13, `expected a partial run, got ${r.passed}`);
  assert.match(r.stoppedBecause, /time budget/);
});
