import { json, methodNotAllowed } from '../../lib/http.js';
import { getSession } from '../../lib/session.js';
import { findById, publicView } from '../../lib/employees.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

  const session = getSession(req);
  if (!session) return json(res, 401, { error: 'not_signed_in' });

  try {
    const emp = await findById(session.sub);
    if (!emp || !emp.isActive) return json(res, 401, { error: 'not_signed_in' });
    return json(res, 200, { ok: true, user: publicView(emp) });
  } catch (err) {
    console.error('me failed', err);
    // The session itself is still valid - fall back to what it carries.
    return json(res, 200, {
      ok: true,
      degraded: true,
      user: {
        id: session.sub, name: session.name, email: session.email,
        designation: session.designation, desk: session.desk, role: session.role,
        mustChangePassword: session.mcp === 1, isActive: true,
      },
    });
  }
}
