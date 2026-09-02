/**
 * Session tokens: compact JWT-shaped, HMAC-SHA256 signed with SESSION_SECRET.
 * Hand-rolled on node:crypto so there is no auth dependency to keep patched.
 */
import crypto from 'node:crypto';

export const COOKIE_NAME = 'mbz_session';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (str) => Buffer.from(str, 'base64url');

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error('SESSION_SECRET is missing or shorter than 32 characters');
  }
  return s;
}

function sessionSeconds() {
  const hours = Number(process.env.SESSION_HOURS || 8);
  return Math.round((Number.isFinite(hours) && hours > 0 ? hours : 8) * 3600);
}

export function signSession(payload, maxAgeSeconds = sessionSeconds()) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat: now, exp: now + maxAgeSeconds }));
  const data = `${head}.${body}`;
  const sig = b64u(crypto.createHmac('sha256', secret()).update(data).digest());
  return `${data}.${sig}`;
}

export function verifySession(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const data = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac('sha256', secret()).update(data).digest();

  let given;
  try { given = unb64u(parts[2]); } catch { return null; }
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;

  let body;
  try { body = JSON.parse(unb64u(parts[1]).toString('utf8')); } catch { return null; }
  if (typeof body?.exp !== 'number' || body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

export function readCookies(req) {
  const raw = req.headers?.cookie;
  if (!raw) return {};
  const out = {};
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=');
    if (i < 1) continue;
    const k = pair.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(pair.slice(i + 1).trim()); }
    catch { out[k] = pair.slice(i + 1).trim(); }
  }
  return out;
}

function serialise(name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (opts.maxAge != null) bits.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) bits.push(`Expires=${opts.expires.toUTCString()}`);
  // Vercel always terminates TLS; only a bare local http run should omit Secure.
  if (process.env.NODE_ENV !== 'development' && process.env.MBZ_INSECURE_COOKIES !== '1') {
    bits.push('Secure');
  }
  return bits.join('; ');
}

function appendSetCookie(res, cookie) {
  const existing = res.getHeader?.('Set-Cookie');
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  list.push(cookie);
  res.setHeader('Set-Cookie', list);
}

export function setSessionCookie(res, payload) {
  const maxAge = sessionSeconds();
  appendSetCookie(res, serialise(COOKIE_NAME, signSession(payload, maxAge), { maxAge }));
}

export function clearSessionCookie(res) {
  appendSetCookie(res, serialise(COOKIE_NAME, '', { maxAge: 0, expires: new Date(0) }));
}

/** Returns the session payload, or null when there is no valid session. */
export function getSession(req) {
  return verifySession(readCookies(req)[COOKIE_NAME]);
}
