import { json, methodNotAllowed, readJsonBody } from '../http.js';
import { getSession } from '../session.js';
import { redact } from '../config.js';
import { createOrder } from '../orders.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const session = getSession(req);
  if (!session) return json(res, 401, { error: 'not_signed_in' });

  let body;
  try { body = await readJsonBody(req); }
  catch { return json(res, 413, { error: 'body_too_large' }); }

  try {
    const result = await createOrder({ body, user: { email: session.email, name: session.name } });
    if (!result.ok) {
      return json(res, 400, { error: 'invalid_order', problems: result.problems });
    }
    return json(res, 201, {
      ok: true,
      order: result.order,
      // Said plainly: the order is saved whatever the spreadsheet did.
      saved: true,
      sheet: result.sheet,
      message: result.sheet.ok
        ? (result.sheet.skipped ? 'Order saved. Google Sheets is not configured, so nothing was mirrored.'
                                : 'Order saved and written to the sheet.')
        : 'Order saved. The sheet could not be written and will be retried.',
    });
  } catch (err) {
    console.error('order create failed', redact(err?.stack || err));
    return json(res, 500, {
      error: 'order_failed',
      message: 'The order could not be saved.',
      detail: redact(err?.message || err),
    });
  }
}
