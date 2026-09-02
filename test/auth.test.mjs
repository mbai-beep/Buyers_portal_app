/**
 * End-to-end walk of the login flow against a throwaway local libSQL file.
 * No network, no Turso account needed.
 *
 *   npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = path.join(ROOT, 'test-local.db');

process.env.TURSO_DATABASE_URL = `file:${DB_FILE}`;
process.env.TURSO_AUTH_TOKEN = '';
process.env.SESSION_SECRET = 'test-secret-at-least-thirty-two-characters-long';
process.env.MBZ_INSECURE_COOKIES = '1';
process.env.PORTAL_ADMIN_EMAILS = 'admin@mbindia.net';
delete process.env.SESSION_HOURS;

const { initSchema } = await import('../lib/db.js');
const { upsertEmployee, findByEmail } = await import('../lib/employees.js');
const { signSession, verifySession } = await import('../lib/session.js');
const { hashPassword, verifyPassword, matchesDefault, defaultPasswordFor, passwordProblem } =
  await import('../lib/passwords.js');

const login = (await import('../api/auth/login.js')).default;
const me = (await import('../api/auth/me.js')).default;
const logout = (await import('../api/auth/logout.js')).default;
const changePassword = (await import('../api/auth/change-password.js')).default;
const portal = (await import('../api/portal.js')).default;
const employees = (await import('../api/employees.js')).default;

/* ---------------------------------------------------------- tiny harness */
function call(handler, { method = 'GET', body = null, cookie = null, url = '/' } = {}) {
  const req = new http.IncomingMessage(null);
  req.method = method;
  req.url = url;
  req.headers = { 'user-agent': 'node-test' };
  if (cookie) req.headers.cookie = cookie;
  if (body) req.body = body;
  Object.defineProperty(req, 'socket', { value: { remoteAddress: '127.0.0.1' }, writable: true });

  const chunks = [];
  const res = {
    statusCode: 200,
    _headers: {},
    setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
    getHeader(k) { return this._headers[k.toLowerCase()]; },
    headersSent: false,
    end(payload) { if (payload) chunks.push(payload); this._done = true; return this; },
  };

  return Promise.resolve(handler(req, res)).then(() => {
    const text = chunks.map((c) => (Buffer.isBuffer(c) ? c.toString('utf8') : String(c))).join('');
    let json = null;
    try { json = JSON.parse(text); } catch { /* html or redirect */ }
    const setCookie = res._headers['set-cookie'];
    const list = setCookie ? (Array.isArray(setCookie) ? setCookie : [setCookie]) : [];
    return {
      status: res.statusCode,
      headers: res._headers,
      text,
      json,
      setCookie: list,
      cookie: list.map((c) => c.split(';')[0]).join('; '),
    };
  });
}

before(async () => {
  rmSync(DB_FILE, { force: true });
  await initSchema();
  await upsertEmployee({
    name: 'Chetna Wadhwani', email: 'chetna@mbindia.net',
    designation: 'Head of Buying & Merchandising', department: 'Chetna',
    desk: 'The Suit Pieces desk', role: 'buyer',
  });
  await upsertEmployee({
    name: 'Ravi Khanna', email: 'ravi@mbindia.net',
    designation: 'Merchandiser', department: 'Chetna',
    desk: 'The Suit Pieces desk', role: 'buyer',
  });
});

after(() => rmSync(DB_FILE, { force: true }));

/* ------------------------------------------------------------ unit bits */
test('default password is MBZ + the email address', () => {
  assert.equal(defaultPasswordFor('Chetna@MBindia.net'), 'MBZchetna@mbindia.net');
  assert.ok(matchesDefault('MBZchetna@mbindia.net', 'chetna@mbindia.net'));
  assert.ok(!matchesDefault('mbzchetna@mbindia.net', 'chetna@mbindia.net'));
  assert.ok(!matchesDefault('MBZchetna@mbindia.ne', 'chetna@mbindia.net'));
});

test('password hashing round-trips and rejects near misses', () => {
  const h = hashPassword('Portal2026pass');
  assert.ok(verifyPassword('Portal2026pass', h));
  assert.ok(!verifyPassword('Portal2026Pass', h));
  assert.ok(!verifyPassword('', h));
  assert.ok(!verifyPassword('Portal2026pass', 'not-a-hash'));
  assert.notEqual(hashPassword('same'), hashPassword('same'), 'salt must differ per hash');
});

test('password policy', () => {
  assert.ok(passwordProblem('short1'));
  assert.ok(passwordProblem('allletterspassword'));
  assert.ok(passwordProblem('1234567890'));
  assert.equal(passwordProblem('Suitpieces2026'), null);
});

test('session tokens are tamper-evident and expire', () => {
  const token = signSession({ sub: 1, email: 'a@b.co' });
  assert.equal(verifySession(token).email, 'a@b.co');
  assert.equal(verifySession(token.slice(0, -2) + 'xy'), null);
  assert.equal(verifySession('rubbish'), null);
  assert.equal(verifySession(signSession({ sub: 1 }, -10)), null, 'expired token must not verify');
});

/* --------------------------------------------------------- the flow */
test('unknown email is refused without saying it is unknown', async () => {
  const r = await call(login, { method: 'POST', body: { email: 'nobody@mbindia.net', password: 'whatever' } });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'invalid_login');
  assert.match(r.json.message, /not right/);
  assert.equal(r.setCookie.length, 0);
});

test('wrong password is refused with the same message', async () => {
  const r = await call(login, { method: 'POST', body: { email: 'chetna@mbindia.net', password: 'nope' } });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, 'invalid_login');
});

test('GET on the login endpoint is not allowed', async () => {
  const r = await call(login, { method: 'GET' });
  assert.equal(r.status, 405);
});

test('the portal redirects to login when there is no session', async () => {
  const r = await call(portal);
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/login?next=%2Fportal');
});

let session = null;

test('first login on MBZ<email> works and demands a new password', async () => {
  const r = await call(login, {
    method: 'POST',
    body: { email: 'Chetna@mbindia.NET', password: 'MBZchetna@mbindia.net' },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.mustChangePassword, true);
  assert.equal(r.json.user.name, 'Chetna Wadhwani');
  assert.equal(r.json.user.designation, 'Head of Buying & Merchandising');
  assert.equal(r.json.user.passwordHash, undefined, 'must never send the hash to the browser');
  assert.equal(r.json.next, '/portal');

  const cookie = r.setCookie[0];
  assert.match(cookie, /^mbz_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  session = r.cookie;
});

test('the issued password is hashed on that first login', async () => {
  const emp = await findByEmail('chetna@mbindia.net');
  assert.ok(emp.passwordHash, 'hash should now be stored');
  assert.ok(emp.mustChangePassword);
  assert.ok(verifyPassword('MBZchetna@mbindia.net', emp.passwordHash));
});

test('the session opens the portal and carries the employee into the page', async () => {
  const r = await call(portal, { cookie: session });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.headers['cache-control'], /no-store/);
  assert.ok(r.text.includes('"Chetna Wadhwani"'), 'name should be injected');
  assert.ok(r.text.includes('window.__MB_USER'), 'identity slot should be present');
  assert.ok(!r.text.includes('/*MB_USER*/null/*MB_USER*/'), 'slot should have been filled');
});

test('/api/auth/me reports the signed-in employee', async () => {
  const r = await call(me, { cookie: session });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.email, 'chetna@mbindia.net');
  assert.equal(r.json.user.passwordHash, undefined);
});

test('the employee directory needs a session', async () => {
  assert.equal((await call(employees)).status, 401);
  const r = await call(employees, { cookie: session });
  assert.equal(r.status, 200);
  assert.equal(r.json.count, 2);
  assert.ok(r.json.employees.every((e) => e.passwordHash === undefined));
  // A colleague sees who someone is, not the state of their account.
  assert.ok(r.json.employees.every((e) => e.mustChangePassword === undefined));
  assert.ok(r.json.employees.every((e) => e.lastLoginAt === undefined));
  assert.deepEqual(
    Object.keys(r.json.employees[0]).sort(),
    ['department', 'designation', 'desk', 'email', 'id', 'name', 'role']
  );
});

test('changing the password needs the current one', async () => {
  const bad = await call(changePassword, {
    method: 'POST', cookie: session,
    body: { currentPassword: 'wrong', newPassword: 'Suitpieces2026' },
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error, 'wrong_current_password');
});

test('the new password cannot be the issued one', async () => {
  const r = await call(changePassword, {
    method: 'POST', cookie: session,
    body: { currentPassword: 'MBZchetna@mbindia.net', newPassword: 'MBZchetna@mbindia.net' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'default_password');
});

test('a weak new password is refused', async () => {
  const r = await call(changePassword, {
    method: 'POST', cookie: session,
    body: { currentPassword: 'MBZchetna@mbindia.net', newPassword: 'short' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'weak_password');
});

test('a good new password is accepted and clears the flag', async () => {
  const r = await call(changePassword, {
    method: 'POST', cookie: session,
    body: { currentPassword: 'MBZchetna@mbindia.net', newPassword: 'Suitpieces2026' },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.user.mustChangePassword, false);
  session = r.cookie || session;

  const emp = await findByEmail('chetna@mbindia.net');
  assert.ok(!emp.mustChangePassword);
  assert.ok(verifyPassword('Suitpieces2026', emp.passwordHash));
});

test('the issued password stops working once a real one is set', async () => {
  const r = await call(login, {
    method: 'POST', body: { email: 'chetna@mbindia.net', password: 'MBZchetna@mbindia.net' },
  });
  assert.equal(r.status, 401);
});

test('the new password signs in cleanly, with no change prompt', async () => {
  const r = await call(login, {
    method: 'POST', body: { email: 'chetna@mbindia.net', password: 'Suitpieces2026' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.mustChangePassword, false);
  session = r.cookie;
});

test('logout clears the cookie', async () => {
  const r = await call(logout, { method: 'POST', cookie: session });
  assert.equal(r.status, 200);
  assert.match(r.setCookie[0], /Max-Age=0/);
});

test('a session signed with another secret is refused', async () => {
  const real = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'a-completely-different-secret-value-here';
  const forged = signSession({ sub: 1, email: 'chetna@mbindia.net' });
  process.env.SESSION_SECRET = real;
  const r = await call(portal, { cookie: `mbz_session=${forged}` });
  assert.equal(r.status, 302);
});

test('repeated failures lock the account for a while', async () => {
  for (let i = 0; i < 8; i++) {
    await call(login, { method: 'POST', body: { email: 'ravi@mbindia.net', password: `bad${i}` } });
  }
  const r = await call(login, {
    method: 'POST', body: { email: 'ravi@mbindia.net', password: 'MBZravi@mbindia.net' },
  });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'too_many_attempts');
});
