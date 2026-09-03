import { json, methodNotAllowed } from '../http.js';
import { getSession } from '../session.js';
import { redact } from '../config.js';
import { listOrders, getOrder } from '../orders.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const session = getSession(req);
  if (!session) return json(res, 401, { error: 'not_signed_in' });

  const params = Object.fromEntries(new URL(req.url || '/', 'http://x').searchParams);
  try {
    if (params.orderNo) {
      const order = await getOrder(params.orderNo);
      if (!order) return json(res, 404, { error: 'not_found' });
      return json(res, 200, { ok: true, order });
    }
    const orders = await listOrders({ supplierAlias: params.alias || null, limit: params.limit });
    return json(res, 200, { ok: true, count: orders.length, orders });
  } catch (err) {
    console.error('order list failed', redact(err?.stack || err));
    return json(res, 500, { error: 'order_list_failed', detail: redact(err?.message || err) });
  }
}
