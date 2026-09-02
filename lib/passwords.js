/**
 * Password handling.
 *
 * Day-one rule from the brief: every employee's password is MBZ<their email>.
 * That is a *derivable* secret, so it is treated as a one-time enrolment
 * credential only: the first successful login hashes whatever was submitted,
 * stores it, and flags must_change_password. After the employee sets a real
 * password the derived one stops working.
 */
import crypto from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function defaultPasswordFor(email) {
  return `MBZ${String(email || '').trim().toLowerCase()}`;
}

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(plain, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 96 * 1024 * 1024,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  let salt, key;
  try {
    salt = Buffer.from(saltB64, 'base64');
    key = Buffer.from(keyB64, 'base64');
  } catch { return false; }
  let candidate;
  try {
    candidate = crypto.scryptSync(plain, salt, key.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 96 * 1024 * 1024,
    });
  } catch { return false; }
  return candidate.length === key.length && crypto.timingSafeEqual(candidate, key);
}

/** Constant-time-ish compare for the derived enrolment password. */
export function matchesDefault(plain, email) {
  const a = Buffer.from(String(plain ?? ''), 'utf8');
  const b = Buffer.from(defaultPasswordFor(email), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function passwordProblem(pw) {
  const s = String(pw ?? '');
  if (s.length < 10) return 'Password must be at least 10 characters.';
  if (s.length > 200) return 'Password must be 200 characters or fewer.';
  if (!/[A-Za-z]/.test(s)) return 'Password must contain a letter.';
  if (!/[0-9]/.test(s)) return 'Password must contain a number.';
  return null;
}
