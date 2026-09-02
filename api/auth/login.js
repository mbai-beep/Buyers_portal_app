import { json, methodNotAllowed, readJsonBody, clientIp, normaliseEmail, isEmail } from '../../lib/http.js';
import { setSessionCookie } from '../../lib/session.js';
import { hashPassword, verifyPassword, matchesDefault, defaultPasswordFor } from '../../lib/passwords.js';
import {
  findByEmail, setPasswordHash, touchLogin, audit, recentFailures, publicView,
} from '../../lib/employees.js';

const MAX_FAILURES = 8;

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);

  let body;
  try { body = await readJsonBody(req); }
  catch { return json(res, 413, { error: 'body_too_large' }); }

  const email = normaliseEmail(body.email);
  const password = String(body.password ?? '');
  const ip = clientIp(req);
  const ua = req.headers['user-agent'];

  if (!email || !password) {
    return json(res, 400, { error: 'missing_credentials', message: 'Enter your email address and password.' });
  }
  if (!isEmail(email)) {
    return json(res, 400, { error: 'bad_email', message: 'That does not look like an email address.' });
  }

  try {
    if (await recentFailures(email) >= MAX_FAILURES) {
      await audit(email, 'locked', ip, ua);
      return json(res, 429, {
        error: 'too_many_attempts',
        message: 'Too many failed attempts. Wait 15 minutes and try again.',
      });
    }

    const emp = await findByEmail(email);

    // Same response shape and roughly the same work for unknown and wrong, so
    // the form cannot be used to enumerate who works here.
    if (!emp) {
      verifyPassword(password, hashPassword('decoy-for-timing'));
      await audit(email, 'unknown_email', ip, ua);
      return json(res, 401, { error: 'invalid_login', message: 'Email address or password is not right.' });
    }
    if (!emp.isActive) {
      await audit(email, 'inactive', ip, ua);
      return json(res, 403, { error: 'inactive', message: 'This account is no longer active. Contact IT.' });
    }

    let ok = false;
    let enrolled = false;

    if (emp.passwordHash) {
      ok = verifyPassword(password, emp.passwordHash);
    } else if (matchesDefault(password, emp.email)) {
      // First login on the issued MBZ<email> credential: capture it as a hash
      // so the derived form stops being the thing on the wire, and demand a change.
      ok = true;
      enrolled = true;
      await setPasswordHash(emp.id, hashPassword(defaultPasswordFor(emp.email)), { mustChange: true });
    }

    if (!ok) {
      await audit(email, 'bad_password', ip, ua);
      return json(res, 401, { error: 'invalid_login', message: 'Email address or password is not right.' });
    }

    await touchLogin(emp.id);
    await audit(email, enrolled ? 'first_login' : 'ok', ip, ua);

    const user = publicView({ ...emp, mustChangePassword: enrolled ? true : emp.mustChangePassword });

    setSessionCookie(res, {
      sub: emp.id,
      email: emp.email,
      name: emp.name,
      designation: emp.designation,
      desk: emp.desk,
      role: user.isAdmin ? 'admin' : emp.role,
      mcp: user.mustChangePassword ? 1 : 0,
    });

    return json(res, 200, { ok: true, user, mustChangePassword: user.mustChangePassword, next: '/portal' });
  } catch (err) {
    console.error('login failed', err);
    return json(res, 500, {
      error: 'server_error',
      message: 'Could not reach the employee directory. Try again in a moment.',
    });
  }
}
