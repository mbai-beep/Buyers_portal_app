/**
 * Configuration checks with distinguishable outcomes.
 *
 * "Could not reach the employee directory" used to be returned for a missing
 * SESSION_SECRET as well as for an actual Turso failure - two unrelated causes
 * behind one message, which is not a diagnosis. These helpers separate them.
 */

export function sessionSecretProblem() {
  const s = process.env.SESSION_SECRET;
  if (!s) return 'SESSION_SECRET is not set';
  if (s.length < 32) return `SESSION_SECRET is ${s.length} characters; 32 or more are required`;
  return null;
}

export function directoryConfigProblem() {
  if (!process.env.TURSO_DATABASE_URL && !process.env.LIBSQL_URL) {
    return 'TURSO_DATABASE_URL is not set';
  }
  const url = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL;
  if (!url.startsWith('file:') && !process.env.TURSO_AUTH_TOKEN) {
    return 'TURSO_AUTH_TOKEN is not set (required for a libsql:// URL)';
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return `TURSO_DATABASE_URL should start with libsql:// (got ${url.slice(0, 8)}…)`;
  }
  return null;
}

/** Never echo a token back in an error body or a log line. */
export function redact(text) {
  return String(text ?? '')
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g, '«token»')
    .replace(/(authToken=)[^&\s]+/gi, '$1«token»');
}

/**
 * Turns a libSQL failure into something actionable. The raw message is logged
 * for the function log; only the classification reaches the browser.
 */
export function classifyDirectoryError(err) {
  const m = String(err?.message || err).toLowerCase();
  const code = String(err?.code || '');

  if (m.includes('turso_database_url')) {
    return { reason: 'not_configured', hint: 'TURSO_DATABASE_URL is not set in this environment.' };
  }
  if (m.includes('no such table') || code === 'SQLITE_UNKNOWN') {
    return { reason: 'schema_missing',
             hint: "This app's sign-in table (portal_users) has not been created yet. " +
                   'Run POST /api/admin/bootstrap once with the BOOTSTRAP_TOKEN header.' };
  }
  if (m.includes('no such column')) {
    return { reason: 'schema_mismatch',
             hint: 'portal_users exists but is missing columns this version needs. ' +
                   'Run POST /api/admin/bootstrap to add them.' };
  }
  if (m.includes('401') || m.includes('unauthor') || m.includes('forbidden') || m.includes('expired')) {
    return { reason: 'auth_rejected',
             hint: 'Turso rejected the auth token - it may be for a different database, or invalidated.' };
  }
  if (m.includes('enotfound') || m.includes('eai_again') || m.includes('dns')) {
    return { reason: 'host_not_found', hint: 'The TURSO_DATABASE_URL hostname does not resolve. Check it for typos.' };
  }
  if (m.includes('timeout') || m.includes('etimedout') || m.includes('econnrefused') || m.includes('socket')) {
    return { reason: 'unreachable', hint: 'Could not open a connection to Turso.' };
  }
  return { reason: 'unknown', hint: 'See the function log for the underlying error.' };
}
