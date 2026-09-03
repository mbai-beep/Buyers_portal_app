/**
 * Routes several endpoints through one serverless function.
 *
 * Vercel's Hobby plan allows 12 functions per deployment and this app needs
 * more endpoints than that, so the reports, admin and health families each
 * live behind a single function. vercel.json rewrites the readable paths
 * (/api/reports/home) onto it, so nothing a caller uses has changed.
 */
import { json } from './http.js';

export function dispatcher(routes, { param, family }) {
  const names = Object.keys(routes);

  return async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://x');

    // Either the rewrite supplied it, or the path still carries it.
    let name = url.searchParams.get(param);
    if (!name) {
      const tail = url.pathname.replace(/\/+$/, '').split('/').pop();
      if (tail && tail !== family) name = tail;
    }
    if (!name) name = 'index';

    const route = routes[name];
    if (!route) {
      return json(res, 404, {
        error: 'unknown_endpoint',
        message: `No ${family} endpoint called "${name}".`,
        available: names.filter((n) => n !== 'index').map((n) => `/api/${family}/${n}`),
        // The list above is whatever this build registers, so it doubles as a
        // statement of which build is answering. The commit makes that explicit.
        deployedCommit: (process.env.VERCEL_GIT_COMMIT_SHA || 'unknown').slice(0, 7),
      });
    }
    return route(req, res);
  };
}
