/**
 * The reporting layer, tested without a SQL Server.
 *
 * zRetailHQ0 is not reachable from a test runner, so lib/sql.js is mocked and
 * the assertions are about what this code is responsible for: the SQL it
 * builds, the parameters it binds, the period maths, the net-of-returns
 * arithmetic and the way the supplier book is merged. Whether the server
 * likes the SQL is answered by /api/reports/selftest against the real thing.
 *
 *   node --experimental-test-module-mocks --test test/reports.test.mjs
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.SESSION_SECRET = 'test-secret-at-least-thirty-two-characters-long';
process.env.REPORT_TODAY = '2026-09-02';
process.env.REPORT_CACHE_SECONDS = '0';

/** Every query the code under test issues, in order. */
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

/* ------------------------------------------------------------- period maths */

test('periods resolve against a fixed today', () => {
  assert.deepEqual(resolvePeriod({ period: 'd1' }), { from: '2026-09-02', to: '2026-09-02', label: 'today' });
  assert.deepEqual(resolvePeriod({ period: 'd7' }).from, '2026-08-27');
  assert.deepEqual(resolvePeriod({ period: 'd30' }).from, '2026-08-04');
  assert.deepEqual(resolvePeriod({ period: 'mtd' }).from, '2026-09-01');
  assert.deepEqual(resolvePeriod({ period: 'fy' }).from, '2026-04-01', 'Indian FY starts 1 April');
  assert.deepEqual(resolvePeriod({ from: '2026-01-01', to: '2026-01-31' }).label, '2026-01-01 to 2026-01-31');
});

test('a financial year before April belongs to the previous year', () => {
  assert.equal(reports.financialYearStart(new Date('2026-03-31T00:00:00Z')), '2025-04-01');
  assert.equal(reports.financialYearStart(new Date('2026-04-01T00:00:00Z')), '2026-04-01');
});

test('bad periods and dates are refused, not coerced', () => {
  assert.throws(() => resolvePeriod({ period: 'last-tuesday' }), /unknown period/);
  assert.throws(() => resolvePeriod({ from: '2026-12-01', to: '2026-01-01' }), /after/);
  assert.throws(() => reports.isoDate('01/02/2026'), /YYYY-MM-DD/);
  assert.throws(() => reports.isoDate("2026-01-01'; DROP TABLE x--"), /YYYY-MM-DD/);
});

/* ------------------------------------------------- what reaches the server */

test('dates are bound as parameters, never interpolated', async () => {
  responder = () => [{}];
  await reports.salesTotals({ from: '2026-08-01', to: '2026-08-31' });
  const q = issued[0];
  assert.match(q.text, /CashmemoDt >= @from AND CashmemoDt <= @to/);
  assert.ok(!q.text.includes('2026-08-01'), 'a date must not appear in the SQL text');
  assert.deepEqual(q.params.from, { type: 'Date', value: '2026-08-01' });
  assert.deepEqual(q.params.to, { type: 'Date', value: '2026-08-31' });
});

test('a supplier alias is bound, not interpolated', async () => {
  responder = () => [{}];
  await reports.sizeMix({ from: '2026-08-01', to: '2026-08-31', supplierAlias: "AHD'; DROP--" });
  const q = issued[0];
  assert.match(q.text, /SupplierAlias = @alias/);
  assert.ok(!q.text.includes('DROP'), 'the alias must not reach the SQL text');
  assert.equal(q.params.alias.value, "AHD'; DROP--");
});

test('a row limit can only ever be a bounded integer', async () => {
  responder = () => [];
  // Note the last case: a value like "10; DROP TABLE x" is rejected outright
  // rather than salvaged down to 10, because Number() of it is NaN. Falling
  // back to the default is the safer of the two behaviours.
  for (const [given, expected] of [['5', 5], ['abc', 50], ['-3', 50], ['999999', 2000],
                                   ['10; DROP TABLE x', 50], ['7.9', 7]]) {
    issued = [];
    await reports.bestSellers({ from: '2026-08-01', to: '2026-08-31', limit: given });
    assert.match(issued[0].text, new RegExp(`SELECT TOP ${expected}\\b`), `limit ${given} -> TOP ${expected}`);
    assert.ok(!/DROP/.test(issued[0].text));
  }
});

test('a renamed view is validated before it reaches a statement', async () => {
  const original = process.env.SQL_VIEW_SALES;
  process.env.SQL_VIEW_SALES = 'VW_X; DROP TABLE Sales--';
  const fresh = await import(`../lib/reports.js?evil=${Date.now()}`);
  await assert.rejects(() => fresh.salesTotals({ from: '2026-08-01', to: '2026-08-02' }), /unsafe object name/);
  if (original === undefined) delete process.env.SQL_VIEW_SALES;
  else process.env.SQL_VIEW_SALES = original;
});

test('reads are hinted so a scan cannot sit in front of the tills', async () => {
  responder = () => [{}];
  await reports.salesTotals({ from: '2026-08-01', to: '2026-08-31' });
  assert.match(issued[0].text, /WITH \(NOLOCK\)/);
});

/* --------------------------------------------------- net of returns, always */

test('sold is SLS minus SLR, and the reported pair is carried, not used', async () => {
  responder = () => [{
    grossQty: 1000, returnQty: 120, grossValue: 500000, returnValue: 60000,
    reportedQty: 1000, reportedValue: 500000,
    bills: 300, articles: 80, suppliers: 12, branches: 4,
  }];
  const t = await reports.salesTotals({ from: '2026-08-01', to: '2026-08-31' });
  assert.equal(t.netQty, 880);
  assert.equal(t.netValue, 440000);
  assert.equal(t.reportedQty, 1000, 'kept for comparison');
});

test('reconcile names which reading SalesQuantity is', async () => {
  const cases = [
    [{ grossQty: 1000, returnQty: 120, reportedQty: 880 }, /already NET/],
    [{ grossQty: 1000, returnQty: 120, reportedQty: 1000 }, /GROSS/],
    [{ grossQty: 1000, returnQty: 120, reportedQty: 4242 }, /matches neither/],
    [{ grossQty: 1000, returnQty: 0, reportedQty: 1000 }, /cannot be told apart/],
  ];
  for (const [row, expected] of cases) {
    responder = () => [{ grossValue: 0, returnValue: 0, reportedValue: 0, ...row }];
    const r = await reports.reconcileSales({ from: '2026-08-01', to: '2026-08-31' });
    assert.match(r.conclusion, expected);
    assert.match(r.portalUses, /SLSQty minus SLRQty/);
  }
});

/* ------------------------------------------------------------- the balance */

test('with-us is purchases less supplier returns less net sold ever', async () => {
  responder = (text) => {
    const t = text.replace(/\s+/g, ' ');
    if (/SUM\(ISNULL\(PurQty/.test(t)) return [{ qty: 900000, value: 9e8, suppliers: 225, articles: 12090, invoices: 5000 }];
    if (/SUM\(ISNULL\(PrtQty/.test(t)) return [{ qty: 40000, value: 4e7, notes: 900 }];
    if (/AS grossQty, CAST\(SUM\(ISNULL\(SLRQty, 0\)\) AS float\) AS returnQty FROM/.test(t)) {
      return [{ grossQty: 640000, returnQty: 32186 }];          // netSoldEver
    }
    return [{ grossQty: 120000, returnQty: 6000, grossValue: 6e7, returnValue: 3e6,
              reportedQty: 114000, reportedValue: 5.7e7, bills: 9000, articles: 900,
              suppliers: 180, branches: 40 }];
  };
  const h = await reports.homeTotals({ from: '2026-08-04', to: '2026-09-02' });
  const netSoldEver = 640000 - 32186;
  assert.equal(h.withUs.qty, 900000 - 40000 - netSoldEver);
  assert.equal(h.withUs.derivedFrom.netSoldEver, netSoldEver, 'the parts are reported, not hidden');
  assert.equal(h.suppliers, 225);
  assert.equal(h.sold.qty, 114000, 'period sold is net');
  assert.equal(h.financialYearFrom, '2026-04-01');
  assert.equal(h.salesReportedVsComputed.agrees, true);
});

/* ------------------------------------------------------- the supplier book */

test('the book merges purchases, sales and returns per supplier', async () => {
  responder = (text) => {
    const t = text.replace(/\s+/g, ' ');
    if (/SUM\(ISNULL\(PurQty/.test(t)) return [
      { SupplierAlias: 'AHD-NIC', SupplierName: 'NEETAS CREATION', SupplierCity: 'Ahmedabad', purQty: 1000, purValue: 500000, articles: 40, Department: 'SP' },
      { SupplierAlias: 'JPR-FLW', SupplierName: 'FLO WING', SupplierCity: 'Jaipur', purQty: 500, purValue: 250000, articles: 20, Department: 'RM' },
      { SupplierAlias: 'NEW-SUP', SupplierName: 'BRAND NEW', SupplierCity: 'Surat', purQty: 200, purValue: 90000, articles: 5, Department: 'SA' },
    ];
    if (/SUM\(ISNULL\(PrtQty/.test(t)) return [{ SupplierAlias: 'AHD-NIC', prtQty: 100 }];
    return [
      { SupplierAlias: 'AHD-NIC', netQty: 600, netValue: 400000 },
      { SupplierAlias: 'JPR-FLW', netQty: 450, netValue: 300000 },
    ];
  };
  const book = await reports.supplierBook({ from: '2026-04-01', to: '2026-09-02' });

  assert.equal(book.length, 3);
  assert.equal(book[0].alias, 'AHD-NIC', 'ordered by sold, descending');

  const nic = book.find((b) => b.alias === 'AHD-NIC');
  assert.equal(nic.balanceQty, 1000 - 100 - 600);
  assert.equal(nic.sellThroughPct, 66.7, '600 of the 900 that stayed');

  const fresh = book.find((b) => b.alias === 'NEW-SUP');
  assert.equal(fresh.soldQty, 0, 'a supplier with no sales is still on the book');
  assert.equal(fresh.balanceQty, 200);

  assert.equal(book.find((b) => b.alias === 'JPR-FLW').returnedToSupplierQty, 0);
});

test('sell-through is null rather than a divide by zero', async () => {
  responder = (text) => {
    const t = text.replace(/\s+/g, ' ');
    if (/SUM\(ISNULL\(PurQty/.test(t)) return [{ SupplierAlias: 'X', SupplierName: 'X', purQty: 0, purValue: 0, articles: 0 }];
    if (/SUM\(ISNULL\(PrtQty/.test(t)) return [];
    return [];
  };
  const book = await reports.supplierBook({ from: '2026-04-01', to: '2026-09-02' });
  assert.equal(book[0].sellThroughPct, null);
});

/* ------------------------------------------------------------------ selftest */

test('selftest reports each query rather than failing on the first', async () => {
  let n = 0;
  responder = () => { if (++n === 3) throw new Error('Invalid column name "Nope"'); return [{}]; };
  const r = await reports.selftest({ from: '2026-08-26', to: '2026-09-02' });
  assert.equal(r.failed, 1);
  assert.ok(r.passed > 8, 'a bad column stops that check only');
  const broken = r.results.find((x) => x.ok === false);
  assert.match(broken.error, /Invalid column name/);
  assert.equal(r.stoppedBecause, null);
});

test('selftest stops at once when the server cannot be reached', async () => {
  // Thirteen checks each waiting out a connect timeout took over three
  // minutes and would be killed by the platform before reporting anything.
  let attempts = 0;
  responder = () => { attempts++; throw new Error('Failed to connect to 38.45.94.39:12866 in 8000ms'); };
  const r = await reports.selftest({ from: '2026-08-26', to: '2026-09-02' });
  assert.equal(attempts, 1, 'only the first check should have been attempted');
  assert.equal(r.failed, 1);
  assert.ok(r.skipped > 10);
  assert.match(r.stoppedBecause, /could not be reached/);
  assert.match(r.results[0].error, /Failed to connect/);
});

test('selftest works to a budget so a slow scan still answers', async () => {
  responder = async () => { await new Promise((r) => setTimeout(r, 30)); return [{}]; };
  const r = await reports.selftest({ from: '2026-08-26', to: '2026-09-02', budgetMs: 60 });
  assert.ok(r.passed >= 1 && r.passed < 13, `expected a partial run, got ${r.passed}`);
  assert.ok(r.skipped > 0);
  assert.match(r.stoppedBecause, /time budget/);
});

test('daily sales come back as plain ISO dates', async () => {
  responder = () => [
    { d: new Date('2026-08-30T00:00:00Z'), netQty: 250, netValue: 120000 },
    { d: '2026-08-31', netQty: 300, netValue: 150000 },
  ];
  const days = await reports.dailySales({ from: '2026-08-30', to: '2026-08-31' });
  assert.deepEqual(days.map((d) => d.date), ['2026-08-30', '2026-08-31']);
  assert.equal(days[0].qty, 250);
});
