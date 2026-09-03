/**
 * The order write path.
 *
 * The Google Sheets call is mocked: no Google host is reachable from a test
 * runner, and the point being tested is not Google's API but that a sheet
 * failure never costs the buyer their order.
 *
 *   npm test
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = path.join(ROOT, 'test-orders.db');
rmSync(DB, { force: true });

process.env.TURSO_DATABASE_URL = `file:${DB}`;
process.env.SESSION_SECRET = 'test-secret-at-least-thirty-two-characters-long';

/** What the sheet was asked to append, and whether it agreed. */
let sheetCalls = [];
let sheetBehaviour = 'ok';

mock.module('../lib/sheets.js', {
  namedExports: {
    sheetsMode: () => (sheetBehaviour === 'off' ? 'off' : 'service_account'),
    sheetId: () => '1NR2D1Lgemn-coqBXaPG1hVNBhiDBhMXT2Ap4Q_8HnTg',
    appendRows: async (tab, rows) => {
      sheetCalls.push({ tab, rows });
      if (sheetBehaviour === 'fail') throw new Error('The caller does not have permission');
      return { appended: rows.length, via: 'service_account' };
    },
    orderRows: (order, lines) => lines.map((l) => [order.order_no, l.article_no, l.qty]),
    captureRows: (kind, ref, by, payload) => [[kind, ref, by, JSON.stringify(payload)]],
    ORDER_SHEET_HEADER: ['Order No'],
    CAPTURE_SHEET_HEADER: ['Kind'],
  },
});

const { initSchema, db } = await import('../lib/db.js');
const orders = await import('../lib/orders.js');
await initSchema();

const user = { email: 'chetna@mbindia.net', name: 'Chetna Wadhwani' };
const line = (over = {}) => ({ articleNo: 'AW26-D-02', colour: 'PINK', sizeName: 'L', qty: 12, rate: 780, ...over });

beforeEach(() => { sheetCalls = []; sheetBehaviour = 'ok'; });

test('the order tables belong to the app and were created', async () => {
  const { rows } = await db().execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'portal_%' ORDER BY name"
  );
  const names = rows.map((r) => String(r.name));
  for (const t of ['portal_captures', 'portal_order_lines', 'portal_orders', 'portal_users']) {
    assert.ok(names.includes(t), `${t} should exist`);
  }
});

test('an order is saved with its lines, totals computed', async () => {
  const r = await orders.createOrder({
    body: { supplierAlias: 'AHD-NIC', supplierName: 'NEETAS CREATION', wantedBy: '2099-01-01',
            termsDays: 120, note: 'Bring the range boards',
            lines: [line(), line({ sizeName: 'XL', qty: 8 })] },
    user,
  });
  assert.equal(r.ok, true);
  assert.equal(r.order.total_qty, 20);
  assert.equal(r.order.total_value, 20 * 780);
  assert.match(r.order.orderNo, /^MBZ\/AHD-NIC\/\d{4}\/001$/);

  const full = await orders.getOrder(r.order.orderNo);
  assert.equal(full.lines.length, 2);
  assert.equal(full.lines[0].articleNo, 'AW26-D-02');
  assert.equal(full.lines[0].lineValue, 12 * 780);
  assert.equal(full.raisedBy, 'chetna@mbindia.net');
});

test('order numbers increment per supplier per month', async () => {
  const a = await orders.createOrder({ body: { supplierAlias: 'JPR-FLW', lines: [line()] }, user });
  const b = await orders.createOrder({ body: { supplierAlias: 'JPR-FLW', lines: [line()] }, user });
  assert.match(a.order.orderNo, /JPR-FLW\/\d{4}\/001$/);
  assert.match(b.order.orderNo, /JPR-FLW\/\d{4}\/002$/);
});

test('the sheet is written, one row per line', async () => {
  await orders.createOrder({ body: { supplierAlias: 'SUR-KRS', lines: [line(), line({ sizeName: 'M' })] }, user });
  assert.equal(sheetCalls.length, 1);
  assert.equal(sheetCalls[0].rows.length, 2, 'one row per line');
});

test('A SHEET FAILURE MUST NOT LOSE THE ORDER', async () => {
  sheetBehaviour = 'fail';
  const r = await orders.createOrder({
    body: { supplierAlias: 'AHD-NIC', lines: [line({ qty: 5 })] }, user,
  });

  assert.equal(r.ok, true, 'the order still succeeded');
  assert.equal(r.sheet.ok, false);
  assert.match(r.sheet.error, /permission/);

  const saved = await orders.getOrder(r.order.orderNo);
  assert.ok(saved, 'the order is in the database');
  assert.equal(saved.lines.length, 1);
  assert.equal(saved.sheet.synced, false, 'and is marked as not mirrored');
  assert.match(saved.sheet.error, /permission/);
});

test('a failed sheet write can be replayed once the sheet is fixed', async () => {
  sheetBehaviour = 'fail';
  const r = await orders.createOrder({ body: { supplierAlias: 'REPLAY-1', lines: [line()] }, user });
  assert.equal((await orders.getOrder(r.order.orderNo)).sheet.synced, false);

  sheetBehaviour = 'ok';
  const replay = await orders.replayFailedSheetWrites({ limit: 50 });
  assert.ok(replay.attempted >= 1);
  assert.equal(replay.results.every((x) => x.ok), true);
  assert.equal((await orders.getOrder(r.order.orderNo)).sheet.synced, true);
});

test('with Sheets unconfigured the order still saves and says so', async () => {
  sheetBehaviour = 'off';
  const r = await orders.createOrder({ body: { supplierAlias: 'NOSHEET', lines: [line()] }, user });
  assert.equal(r.ok, true);
  assert.equal(r.sheet.ok, true);
  assert.equal(r.sheet.skipped, true);
  assert.equal(sheetCalls.length, 0);
  assert.ok(await orders.getOrder(r.order.orderNo));
});

test('a bad order is refused with every problem named', async () => {
  const r = await orders.createOrder({ body: { lines: [] }, user });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /supplierAlias is required/.test(p)));
  assert.ok(r.problems.some((p) => /at least one line/.test(p)));

  const r2 = await orders.createOrder({
    body: { supplierAlias: 'X', lines: [{ articleNo: '', qty: 0 }, { articleNo: 'A', qty: -4 }] }, user,
  });
  assert.equal(r2.ok, false);
  assert.ok(r2.problems.some((p) => /line 1: articleNo is required/.test(p)));
  assert.ok(r2.problems.some((p) => /line 1: qty must be more than zero/.test(p)));
  assert.ok(r2.problems.some((p) => /line 2: qty must be more than zero/.test(p)));
});

test('a wanted-by date before the order date is refused', async () => {
  const r = await orders.createOrder({
    body: { supplierAlias: 'X', orderDate: '2026-09-01', wantedBy: '2026-08-01', lines: [line()] }, user,
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /wantedBy is before/.test(p)));
});

test('nothing is written when validation fails', async () => {
  const before = (await orders.listOrders({ limit: 1000 })).length;
  await orders.createOrder({ body: { supplierAlias: '', lines: [] }, user });
  assert.equal((await orders.listOrders({ limit: 1000 })).length, before);
  assert.equal(sheetCalls.length, 0);
});

test('a duplicate order number is refused rather than overwriting', async () => {
  const first = await orders.createOrder({ body: { supplierAlias: 'DUP', lines: [line()] }, user });
  const again = await orders.createOrder({
    body: { supplierAlias: 'DUP', orderNo: first.order.orderNo, lines: [line()] }, user,
  });
  assert.equal(again.ok, false);
  assert.match(again.problems[0], /already exists/);
});

test('orders list newest first and filter by supplier', async () => {
  const all = await orders.listOrders({ limit: 1000 });
  assert.ok(all.length > 3);
  assert.ok(all[0].id > all[1].id, 'newest first');
  const nic = await orders.listOrders({ supplierAlias: 'AHD-NIC' });
  assert.ok(nic.length >= 2);
  assert.ok(nic.every((o) => o.supplierAlias === 'AHD-NIC'));
});

test('captures are stored and mirrored, and survive a sheet failure', async () => {
  const ok = await orders.capture({ kind: 'trip-note', ref: 'AHD', payload: { city: 'Ahmedabad', want: ['deeper 2XL'] }, user });
  assert.equal(ok.ok, true);
  assert.equal(ok.sheet.ok, true);

  sheetBehaviour = 'fail';
  const still = await orders.capture({ kind: 'trip-note', ref: 'JPR', payload: { city: 'Jaipur' }, user });
  assert.equal(still.ok, true, 'stored despite the sheet');
  assert.equal(still.sheet.ok, false);

  const { rows } = await db().execute(
    "SELECT kind, payload, sheet_synced FROM portal_captures ORDER BY id"
  );
  assert.equal(rows.length, 2);
  assert.equal(JSON.parse(rows[0].payload).city, 'Ahmedabad');
  assert.equal(Number(rows[1].sheet_synced), 0);
});

test('a capture without a kind or payload is refused', async () => {
  assert.equal((await orders.capture({ kind: '', payload: {}, user })).ok, false);
  assert.equal((await orders.capture({ kind: 'x', payload: null, user })).ok, false);
});

test('quantities and rates are coerced, not trusted', async () => {
  const r = await orders.createOrder({
    body: { supplierAlias: 'COERCE', lines: [{ articleNo: 'A', qty: '7', rate: '99.5' }] }, user,
  });
  assert.equal(r.ok, true);
  const full = await orders.getOrder(r.order.orderNo);
  assert.equal(full.lines[0].qty, 7);
  assert.equal(full.lines[0].lineValue, 696.5);
});

test('overlong text is truncated rather than rejected or stored whole', async () => {
  const r = await orders.createOrder({
    body: { supplierAlias: 'TRUNC', note: 'x'.repeat(5000),
            lines: [{ articleNo: 'A'.repeat(300), qty: 1 }] }, user,
  });
  assert.equal(r.ok, true);
  const full = await orders.getOrder(r.order.orderNo);
  assert.equal(full.note.length, 2000);
  assert.equal(full.lines[0].articleNo.length, 100);
});

test('a query against a database missing the order tables heals itself', async () => {
  // A deployment shipped portal_orders in SCHEMA but nothing created it,
  // because migrate() only ran from the bootstrap endpoint. Open Orders
  // answered "no such table: portal_orders". The order paths now migrate and
  // retry rather than requiring someone to remember a manual step.
  const { withSchema, resetSchemaGuard } = await import('../lib/db.js');
  const c = db();

  await c.execute('DROP TABLE IF EXISTS portal_order_lines');
  await c.execute('DROP TABLE IF EXISTS portal_orders');
  resetSchemaGuard();

  await assert.rejects(
    () => c.execute('SELECT COUNT(*) FROM portal_orders'),
    /no such table/,
    'the table really is gone'
  );

  const listed = await orders.listOrders({ limit: 5 });
  assert.ok(Array.isArray(listed), 'listing recreated the table instead of failing');

  const created = await orders.createOrder({
    body: { supplierAlias: 'HEALED', lines: [line()] }, user,
  });
  assert.equal(created.ok, true, 'and an order can be raised straight afterwards');
  assert.ok(await orders.getOrder(created.order.orderNo));
});

test('withSchema does not swallow a real error', async () => {
  const { withSchema } = await import('../lib/db.js');
  await assert.rejects(() => withSchema(async () => { throw new Error('something else broke'); }),
    /something else broke/);
});
