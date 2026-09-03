/**
 * Purchase orders raised in the portal.
 *
 * Turso is the record; the Google Sheet is a mirror written afterwards. A
 * sheet failure is recorded against the order and never fails the request,
 * because the buyer has raised the order either way.
 */
import { db, withSchema } from './db.js';
import { appendRows, orderRows, captureRows, sheetsMode } from './sheets.js';

const ORDER_TAB = process.env.SHEETS_ORDER_TAB || 'Purchase Orders';
const CAPTURE_TAB = process.env.SHEETS_CAPTURE_TAB || 'Captures';

const int = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : 0; };
const money = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const text = (v, max = 400) => (v == null ? null : String(v).slice(0, max));

function isoDate(v, fallback) {
  const s = String(v ?? '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : fallback;
}

/** MBZ/<alias>/<yymm>/<n>, numbered per supplier per month. */
export async function nextOrderNo(alias) {
  const stamp = new Date().toISOString().slice(2, 7).replace('-', '');
  const prefix = `MBZ/${alias}/${stamp}/`;
  const { rows } = await db().execute({
    sql: 'SELECT order_no FROM portal_orders WHERE order_no LIKE ? ORDER BY id DESC LIMIT 1',
    args: [`${prefix}%`],
  });
  const last = rows[0]?.order_no ? Number(String(rows[0].order_no).split('/').pop()) : 0;
  return `${prefix}${String((Number.isFinite(last) ? last : 0) + 1).padStart(3, '0')}`;
}

export function validateOrder(body) {
  const problems = [];
  const alias = String(body?.supplierAlias ?? '').trim();
  if (!alias) problems.push('supplierAlias is required');
  if (alias.length > 100) problems.push('supplierAlias is too long');

  const lines = Array.isArray(body?.lines) ? body.lines : [];
  if (!lines.length) problems.push('an order needs at least one line');
  if (lines.length > 500) problems.push('an order cannot carry more than 500 lines');

  const clean = [];
  lines.forEach((l, i) => {
    const article = String(l?.articleNo ?? '').trim();
    const qty = int(l?.qty);
    if (!article) problems.push(`line ${i + 1}: articleNo is required`);
    if (qty <= 0) problems.push(`line ${i + 1}: qty must be more than zero`);
    const rate = money(l?.rate);
    clean.push({
      article_no: article.slice(0, 100),
      colour: text(l?.colour, 100),
      size_name: text(l?.sizeName, 40),
      qty,
      rate,
      line_value: rate != null ? Math.round(qty * rate * 100) / 100 : null,
    });
  });

  const today = new Date().toISOString().slice(0, 10);
  const orderDate = isoDate(body?.orderDate, today);
  const wantedBy = isoDate(body?.wantedBy, null);
  if (wantedBy && wantedBy < orderDate) problems.push('wantedBy is before the order date');

  return {
    problems,
    order: {
      supplier_alias: alias.slice(0, 100),
      supplier_name: text(body?.supplierName, 150),
      order_date: orderDate,
      wanted_by: wantedBy,
      terms_days: body?.termsDays == null ? null : int(body.termsDays),
      note: text(body?.note, 2000),
    },
    lines: clean,
  };
}

export async function createOrder(args) {
  return withSchema(() => createOrderNow(args));
}

async function createOrderNow({ body, user }) {
  const { problems, order, lines } = validateOrder(body);
  if (problems.length) return { ok: false, problems };

  const c = db();
  const orderNo = String(body?.orderNo || '').trim() || await nextOrderNo(order.supplier_alias);
  const totalQty = lines.reduce((a, l) => a + l.qty, 0);
  const totalValue = Math.round(lines.reduce((a, l) => a + (l.line_value || 0), 0) * 100) / 100;

  const record = {
    ...order, order_no: orderNo,
    raised_by: user.email, raised_by_name: user.name || null,
    total_qty: totalQty, total_value: totalValue,
  };

  try {
    await c.execute({
      sql: `INSERT INTO portal_orders
              (order_no, supplier_alias, supplier_name, raised_by, raised_by_name,
               order_date, wanted_by, terms_days, note, total_qty, total_value)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [orderNo, record.supplier_alias, record.supplier_name, record.raised_by,
             record.raised_by_name, record.order_date, record.wanted_by, record.terms_days,
             record.note, totalQty, totalValue],
    });
  } catch (err) {
    if (/UNIQUE|constraint/i.test(String(err.message))) {
      return { ok: false, problems: [`order number ${orderNo} already exists`] };
    }
    throw err;
  }

  const { rows } = await c.execute({
    sql: 'SELECT id FROM portal_orders WHERE order_no = ?', args: [orderNo],
  });
  const orderId = Number(rows[0]?.id);

  for (const l of lines) {
    await c.execute({
      sql: `INSERT INTO portal_order_lines
              (order_id, order_no, article_no, colour, size_name, qty, rate, line_value)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [orderId, orderNo, l.article_no, l.colour, l.size_name, l.qty, l.rate, l.line_value],
    });
  }

  // The order is saved. Everything below is best effort.
  const sheet = await mirror(() => appendRows(ORDER_TAB, orderRows(record, lines)));
  await c.execute({
    sql: 'UPDATE portal_orders SET sheet_synced = ?, sheet_error = ?, updated_at = datetime(\'now\') WHERE id = ?',
    args: [sheet.ok ? 1 : 0, sheet.ok ? null : String(sheet.error).slice(0, 400), orderId],
  });

  return {
    ok: true,
    order: { id: orderId, orderNo, ...record, lines: lines.length },
    sheet,
  };
}

async function mirror(fn) {
  if (sheetsMode() === 'off') {
    return { ok: true, skipped: true, reason: 'Google Sheets is not configured' };
  }
  try {
    const result = await fn();
    return { ok: true, ...result };
  } catch (err) {
    console.error('sheet mirror failed', err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function listOrders(args = {}) {
  return withSchema(() => listOrdersNow(args));
}

async function listOrdersNow({ supplierAlias = null, limit = 100 } = {}) {
  const n = Math.min(Math.max(Math.floor(Number(limit)) || 100, 1), 1000);
  const { rows } = await db().execute(
    supplierAlias
      ? { sql: `SELECT * FROM portal_orders WHERE supplier_alias = ?
                 ORDER BY id DESC LIMIT ${n}`, args: [supplierAlias] }
      : `SELECT * FROM portal_orders ORDER BY id DESC LIMIT ${n}`
  );
  return rows.map((r) => ({
    id: Number(r.id), orderNo: r.order_no,
    supplierAlias: r.supplier_alias, supplierName: r.supplier_name,
    raisedBy: r.raised_by, raisedByName: r.raised_by_name,
    orderDate: r.order_date, wantedBy: r.wanted_by, termsDays: r.terms_days,
    note: r.note, totalQty: Number(r.total_qty), totalValue: Number(r.total_value),
    status: r.status,
    sheet: { synced: Number(r.sheet_synced) === 1, error: r.sheet_error || null },
    createdAt: r.created_at,
  }));
}

export async function getOrder(orderNo) {
  return withSchema(() => getOrderNow(orderNo));
}

async function getOrderNow(orderNo) {
  const c = db();
  const { rows } = await c.execute({
    sql: 'SELECT * FROM portal_orders WHERE order_no = ? LIMIT 1', args: [String(orderNo)],
  });
  if (!rows.length) return null;
  const { rows: lines } = await c.execute({
    sql: 'SELECT * FROM portal_order_lines WHERE order_no = ? ORDER BY id', args: [String(orderNo)],
  });
  const [order] = await listOrders({}).then((all) => all.filter((o) => o.orderNo === String(orderNo)));
  return {
    ...order,
    lines: lines.map((l) => ({
      articleNo: l.article_no, colour: l.colour, sizeName: l.size_name,
      qty: Number(l.qty), rate: l.rate == null ? null : Number(l.rate),
      lineValue: l.line_value == null ? null : Number(l.line_value),
    })),
  };
}

/** Anything else a person types in that should not be lost. */
export async function capture(args) {
  return withSchema(() => captureNow(args));
}

async function captureNow({ kind, ref, payload, user }) {
  const k = String(kind || '').trim().slice(0, 60);
  if (!k) return { ok: false, problems: ['kind is required'] };
  if (payload == null) return { ok: false, problems: ['payload is required'] };

  const json = JSON.stringify(payload);
  if (json.length > 100000) return { ok: false, problems: ['payload is too large'] };

  const c = db();
  await c.execute({
    sql: 'INSERT INTO portal_captures (kind, ref, captured_by, payload) VALUES (?, ?, ?, ?)',
    args: [k, text(ref, 200), user.email, json],
  });
  const { rows } = await c.execute('SELECT last_insert_rowid() AS id');
  const id = Number(rows[0]?.id);

  const sheet = await mirror(() => appendRows(CAPTURE_TAB, captureRows(k, ref, user.email, payload)));
  await c.execute({
    sql: 'UPDATE portal_captures SET sheet_synced = ?, sheet_error = ? WHERE id = ?',
    args: [sheet.ok ? 1 : 0, sheet.ok ? null : String(sheet.error).slice(0, 400), id],
  });

  return { ok: true, id, kind: k, sheet };
}

/** Re-sends anything the sheet refused earlier. */
export async function replayFailedSheetWrites({ limit = 50 } = {}) {
  const c = db();
  const n = Math.min(Math.max(Math.floor(Number(limit)) || 50, 1), 500);
  const { rows } = await c.execute(
    `SELECT order_no FROM portal_orders WHERE sheet_synced = 0 ORDER BY id LIMIT ${n}`
  );
  const done = [];
  for (const r of rows) {
    const order = await getOrder(r.order_no);
    if (!order) continue;
    const record = {
      order_no: order.orderNo, order_date: order.orderDate,
      supplier_alias: order.supplierAlias, supplier_name: order.supplierName,
      wanted_by: order.wantedBy, terms_days: order.termsDays,
      raised_by: order.raisedBy, raised_by_name: order.raisedByName, note: order.note,
    };
    const lines = order.lines.map((l) => ({
      article_no: l.articleNo, colour: l.colour, size_name: l.sizeName,
      qty: l.qty, rate: l.rate, line_value: l.lineValue,
    }));
    const sheet = await mirror(() => appendRows(ORDER_TAB, orderRows(record, lines)));
    await c.execute({
      sql: 'UPDATE portal_orders SET sheet_synced = ?, sheet_error = ? WHERE order_no = ?',
      args: [sheet.ok ? 1 : 0, sheet.ok ? null : String(sheet.error).slice(0, 400), order.orderNo],
    });
    done.push({ orderNo: order.orderNo, ok: sheet.ok, error: sheet.ok ? null : sheet.error });
  }
  return { attempted: done.length, succeeded: done.filter((d) => d.ok).length, results: done };
}
