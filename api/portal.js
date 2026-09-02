/**
 * Serves the Buyer's Portal SPA, but only to a signed-in employee.
 *
 * The SPA is deliberately NOT in public/ - anything under public/ is served
 * straight off the CDN with no way to check a cookie first. Routing it through
 * a function is what makes the gate real. The file is read once per warm
 * instance and the identity of the signed-in employee is injected into it.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getSession } from '../lib/session.js';

const USER_SLOT = '/*MB_USER*/null/*MB_USER*/';
let template = null;

async function load() {
  if (template) return template;
  const file = path.join(process.cwd(), 'assets', 'MB-Buyers-Portal.html');
  template = await readFile(file, 'utf8');
  if (!template.includes(USER_SLOT)) {
    console.warn('portal template has no MB_USER slot - serving without identity injection');
  }
  return template;
}

export default async function handler(req, res) {
  const session = getSession(req);

  if (!session) {
    res.statusCode = 302;
    res.setHeader('Location', '/login?next=%2Fportal');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.end();
  }

  try {
    const html = await load();
    const user = {
      id: session.sub,
      name: session.name || '',
      email: session.email || '',
      role: session.designation || '',
      designation: session.designation || '',
      desk: session.desk || '',
      mustChangePassword: session.mcp === 1,
      isAdmin: session.role === 'admin',
    };

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    return res.end(html.replace(USER_SLOT, JSON.stringify(user).replace(/</g, '\\u003c')));
  } catch (err) {
    console.error('portal serve failed', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('The portal could not be loaded.');
  }
}
