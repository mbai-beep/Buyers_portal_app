#!/usr/bin/env node
/**
 * Local stand-in for Vercel's routing, so the whole login flow can be walked
 * through without deploying. Maps /api/* onto the files in api/ and serves
 * public/ as static.
 *
 *   npm run dev        ->  http://localhost:3000
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';

loadEnv();
process.env.MBZ_INSECURE_COOKIES ||= '1';   // plain http locally
process.env.SESSION_SECRET ||= 'dev-only-secret-not-for-production-use-0123456789';
process.env.TURSO_DATABASE_URL ||= 'file:local.db';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2',
};

/**
 * The same rewrites vercel.json declares, so a local run routes exactly like
 * production does. The reports, admin and health families each sit behind one
 * function (Vercel's Hobby plan allows 12 per deployment), and the readable
 * path is turned into a query parameter.
 */
const REWRITES = [
  [/^\/login\/?$/, () => '/index.html'],
  [/^\/portal\/?$/, () => '/api/portal'],
  [/^\/api\/reports\/([\w-]+)\/?$/, (m) => `/api/reports?report=${m[1]}`],
  [/^\/api\/admin\/([\w-]+)\/?$/, (m) => `/api/admin?action=${m[1]}`],
  [/^\/api\/health\/([\w-]+)\/?$/, (m) => `/api/health?check=${m[1]}`],
  [/^\/api\/orders\/([\w-]+)\/?$/, (m) => `/api/orders?action=${m[1]}`],
];

async function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(ROOT, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'public'))) { res.statusCode = 403; return res.end('Forbidden'); }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.statusCode = 200;
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('Not found');
  }
}

async function resolveFunction(apiPath) {
  const base = path.join(ROOT, 'api', apiPath.replace(/^\/api\/?/, '').replace(/\/+$/, ''));
  for (const candidate of [`${base}.js`, path.join(base, 'index.js'), path.join(ROOT, 'api', 'index.js')]) {
    try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = url.pathname;
  for (const [re, to] of REWRITES) {
    const m = re.exec(pathname);
    if (!m) continue;
    const rewritten = new URL(to(m), `http://localhost:${PORT}`);
    pathname = rewritten.pathname;
    for (const [k, v] of rewritten.searchParams) url.searchParams.set(k, v);
    break;
  }

  if (pathname.startsWith('/api/')) {
    const file = await resolveFunction(pathname);
    if (!file) { res.statusCode = 404; return res.end('No such function'); }
    try {
      // Cache-bust so edits are picked up without a restart.
      const mod = await import(`${file}?t=${Date.now()}`);
      req.query = Object.fromEntries(url.searchParams);
      req.url = `${pathname}?${url.searchParams.toString()}`;
      await mod.default(req, res);
    } catch (err) {
      console.error(`[${req.method} ${pathname}]`, err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
      }
      res.end(JSON.stringify({ error: 'dev_server_error', message: String(err.message || err) }));
    }
    console.log(`${req.method} ${url.pathname} -> ${pathname} ${res.statusCode}`);
    return;
  }

  await serveStatic(res, pathname);
  console.log(`${req.method} ${url.pathname} ${res.statusCode}`);
});

server.listen(PORT, () => {
  console.log(`Buyer's Portal dev server: http://localhost:${PORT}`);
  console.log(`  directory: ${process.env.TURSO_DATABASE_URL}`);
  console.log('  /login  /portal  /api/health  /api/auth/login');
});
