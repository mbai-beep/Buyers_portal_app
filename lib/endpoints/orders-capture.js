import { json, methodNotAllowed, readJsonBody } from '../http.js';
import { getSession } from '../session.js';
import { redact } from '../config.js';
import { capture } from '../orders.js';

/** Anything a person types that should not be lost when the tab closes. */
export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const session = getSession(req);
  if (!session) return json(res, 401, { error: 'not_signed_in' });

  let body;
  try { body = await readJsonBody(req); }
  catch { return json(res, 413, { error: 'body_too_large' }); }

  try {
    const result = await capture({
      kind: body?.kind, ref: body?.ref, payload: body?.payload,
      user: { email: session.email, name: session.name },
    });
    if (!result.ok) return json(res, 400, { error: 'invalid_capture', problems: result.problems });
    return json(res, 201, { ok: true, saved: true, ...result });
  } catch (err) {
    console.error('capture failed', redact(err?.stack || err));
    return json(res, 500, { error: 'capture_failed', detail: redact(err?.message || err) });
  }
}
