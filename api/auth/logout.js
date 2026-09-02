import { json, methodNotAllowed } from '../../lib/http.js';
import { clearSessionCookie } from '../../lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return methodNotAllowed(res, ['GET', 'POST']);
  clearSessionCookie(res);
  if (req.method === 'GET') {
    res.statusCode = 302;
    res.setHeader('Location', '/login?signedout=1');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.end();
  }
  return json(res, 200, { ok: true });
}
