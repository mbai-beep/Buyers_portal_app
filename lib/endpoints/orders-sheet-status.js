import { json, methodNotAllowed } from '../http.js';
import { getSession } from '../session.js';
import { redact } from '../config.js';
import { sheetsMode, sheetId, ORDER_SHEET_HEADER, CAPTURE_SHEET_HEADER } from '../sheets.js';
import { replayFailedSheetWrites } from '../orders.js';
import { db } from '../db.js';

/**
 * How the sheet mirror is configured, what it has failed to write, and - on
 * POST - a retry of those.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  const session = getSession(req);
  if (!session) return json(res, 401, { error: 'not_signed_in' });

  const mode = sheetsMode();
  const out = {
    ok: true,
    mode,
    sheetId: mode === 'service_account' ? (sheetId() || null) : null,
    serviceAccount: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || null,
    orderTab: process.env.SHEETS_ORDER_TAB || 'Purchase Orders',
    captureTab: process.env.SHEETS_CAPTURE_TAB || 'Captures',
    expectedHeaders: { orders: ORDER_SHEET_HEADER, captures: CAPTURE_SHEET_HEADER },
  };

  try {
    const { rows } = await db().execute(
      `SELECT COUNT(*) AS pending FROM portal_orders WHERE sheet_synced = 0`
    );
    out.ordersAwaitingSheet = Number(rows[0]?.pending || 0);

    if (req.method === 'POST') {
      if (session.role !== 'admin') return json(res, 403, { error: 'admin_only' });
      out.replay = await replayFailedSheetWrites({ limit: 50 });
    }
    return json(res, 200, out);
  } catch (err) {
    console.error('sheet status failed', redact(err?.stack || err));
    return json(res, 500, { error: 'sheet_status_failed', detail: redact(err?.message || err) });
  }
}
