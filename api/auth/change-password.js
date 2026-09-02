import { json, methodNotAllowed, readJsonBody, clientIp } from '../../lib/http.js';
import { getSession, setSessionCookie } from '../../lib/session.js';
import { hashPassword, verifyPassword, matchesDefault, passwordProblem } from '../../lib/passwords.js';
import { findById, setPasswordHash, audit, publicView } from '../../lib/employees.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  const session = getSession(req);
  if (!session) return json(res, 401, { error: 'not_signed_in' });

  let body;
  try { body = await readJsonBody(req); }
  catch { return json(res, 413, { error: 'body_too_large' }); }

  const current = String(body.currentPassword ?? '');
  const next = String(body.newPassword ?? '');

  try {
    const emp = await findById(session.sub);
    if (!emp || !emp.isActive) return json(res, 401, { error: 'not_signed_in' });

    const currentOk = emp.passwordHash
      ? verifyPassword(current, emp.passwordHash)
      : matchesDefault(current, emp.email);
    if (!currentOk) {
      await audit(emp.email, 'change_password_rejected', clientIp(req), req.headers['user-agent']);
      return json(res, 401, { error: 'wrong_current_password', message: 'Your current password is not right.' });
    }
    // Checked before the strength rules so the specific reason wins: the
    // issued MBZ<email> credential has no digit and would otherwise come back
    // as a vague "too weak".
    if (matchesDefault(next, emp.email)) {
      return json(res, 400, {
        error: 'default_password',
        message: 'Pick something other than the password that was issued to you.',
      });
    }

    const problem = passwordProblem(next);
    if (problem) return json(res, 400, { error: 'weak_password', message: problem });

    await setPasswordHash(emp.id, hashPassword(next), { mustChange: false });
    await audit(emp.email, 'password_changed', clientIp(req), req.headers['user-agent']);

    const user = publicView({ ...emp, mustChangePassword: false });
    setSessionCookie(res, {
      sub: emp.id, email: emp.email, name: emp.name,
      designation: emp.designation, desk: emp.desk,
      role: user.isAdmin ? 'admin' : emp.role, mcp: 0,
    });
    return json(res, 200, { ok: true, user });
  } catch (err) {
    console.error('change-password failed', err);
    return json(res, 500, { error: 'server_error', message: 'Could not update the password. Try again.' });
  }
}
