/**
 * Mirrors captured input into a Google Sheet.
 *
 * The sheet is a mirror, never the record. Every order and capture is written
 * to Turso first and this runs afterwards; if it fails, the write still
 * happened and the failure is recorded against the row so it can be replayed.
 * Losing a buyer's order because a spreadsheet was unreachable would be a poor
 * trade for the convenience of having it in a spreadsheet.
 *
 * Two ways to authenticate, whichever suits:
 *
 *   1. A service account. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and
 *      GOOGLE_PRIVATE_KEY, and share the sheet with that email as an Editor.
 *      Signed here with node:crypto, so there is no Google SDK to carry.
 *
 *   2. An Apps Script web app. Set SHEETS_WEBHOOK_URL to its deployment URL.
 *      Simpler to set up and needs no key, but the URL is the credential.
 *
 * With neither set, capture still works and the sheet is simply skipped.
 */
import crypto from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function sheetsMode() {
  if (process.env.SHEETS_WEBHOOK_URL) return 'webhook';
  if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) return 'service_account';
  return 'off';
}

export function sheetId() {
  const raw = process.env.SHEET_ID || '';
  // Accept a full URL as well as a bare id - the id is what people have.
  const m = raw.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : raw.trim();
}

/** Newlines in a private key survive environment variables as literal \n. */
function privateKey() {
  return String(process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

let tokenCache = null;

async function accessToken() {
  if (tokenCache && tokenCache.expires > Date.now() + 30000) return tokenCache.token;

  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({
    iss: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signature = b64u(
    crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(privateKey())
  );

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Google would not issue a token (${res.status}): ${data.error_description || data.error || 'unknown'}`);
  }
  tokenCache = { token: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

/**
 * Appends rows to one tab. Creates nothing: the tab must exist, because
 * guessing at sheet structure is how a spreadsheet someone relies on gets
 * quietly reshaped.
 */
export async function appendRows(tab, rows) {
  const mode = sheetsMode();
  if (mode === 'off') return { skipped: true, reason: 'no Google Sheets credentials configured' };
  if (!rows.length) return { skipped: true, reason: 'nothing to append' };

  if (mode === 'webhook') {
    const res = await fetch(process.env.SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab, rows, secret: process.env.SHEETS_WEBHOOK_SECRET || undefined }),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`the Apps Script web app answered ${res.status}: ${text.slice(0, 200)}`);
    return { appended: rows.length, via: 'webhook' };
  }

  const id = sheetId();
  if (!id) throw new Error('SHEET_ID is not set');

  const token = await accessToken();
  const range = `${encodeURIComponent(tab)}!A1`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}:append` +
              '?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS';

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: rows }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || `HTTP ${res.status}`;
    if (res.status === 403) {
      throw new Error(`${message} - share the sheet with ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL} as an Editor`);
    }
    if (res.status === 400 && /Unable to parse range/i.test(message)) {
      throw new Error(`${message} - the sheet has no tab called "${tab}"`);
    }
    throw new Error(message);
  }
  return {
    appended: data?.updates?.updatedRows ?? rows.length,
    via: 'service_account',
    range: data?.updates?.updatedRange,
  };
}

/** One row per order line, so the sheet can be filtered and pivoted. */
export function orderRows(order, lines) {
  return lines.map((l) => [
    order.order_no, order.order_date, order.supplier_alias, order.supplier_name || '',
    l.article_no, l.colour || '', l.size_name || '', l.qty, l.rate ?? '', l.line_value ?? '',
    order.wanted_by || '', order.terms_days ?? '', order.raised_by_name || order.raised_by,
    order.raised_by, order.note || '', new Date().toISOString(),
  ]);
}

export const ORDER_SHEET_HEADER = [
  'Order No', 'Order Date', 'Supplier Alias', 'Supplier Name', 'Article No', 'Colour',
  'Size', 'Qty', 'Rate', 'Line Value', 'Wanted By', 'Terms Days', 'Raised By',
  'Raised By Email', 'Note', 'Captured At',
];

export function captureRows(kind, ref, by, payload) {
  return [[kind, ref || '', by, JSON.stringify(payload), new Date().toISOString()]];
}

export const CAPTURE_SHEET_HEADER = ['Kind', 'Reference', 'Captured By', 'Payload', 'Captured At'];
