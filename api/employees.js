import { json, methodNotAllowed } from '../lib/http.js';
import { getSession } from '../lib/session.js';
import { listEmployees } from '../lib/employees.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const session = getSession(req);
  if (!session) return json(res, 401, { error: 'not_signed_in' });

  try {
    const isAdmin = session.role === 'admin';
    const includeInactive = isAdmin && req.url?.includes('includeInactive=1');
    const employees = await listEmployees({ includeInactive, full: isAdmin });
    return json(res, 200, { ok: true, count: employees.length, employees });
  } catch (err) {
    console.error('employees failed', err);
    return json(res, 500, { error: 'server_error', message: 'Could not read the employee directory.' });
  }
}
