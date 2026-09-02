/**
 * Shared wrapper for the reporting endpoints: session required, period
 * parsed, SQL failures reported as something actionable rather than a stack.
 */
import { json, methodNotAllowed } from './http.js';
import { getSession } from './session.js';
import { redact } from './config.js';
import { resolvePeriod, queryParams } from './period.js';

export function reportEndpoint(run, { needsPeriod = true } = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);

    const session = getSession(req);
    if (!session) return json(res, 401, { error: 'not_signed_in' });

    const params = queryParams(req);
    let period = null;
    if (needsPeriod) {
      try { period = resolvePeriod(params); }
      catch (err) { return json(res, 400, { error: 'bad_period', message: String(err.message || err) }); }
    }

    const started = Date.now();
    try {
      const data = await run({ period, params, session });
      return json(res, 200, { ok: true, period, ms: Date.now() - started, ...data });
    } catch (err) {
      console.error('report failed', redact(err?.stack || err?.message || err));
      const message = String(err?.message || err);
      const unreachable = /ETIMEOUT|ESOCKET|ECONNREFUSED|ENOTFOUND|Failed to connect|timeout/i.test(message);
      return json(res, unreachable ? 503 : 500, {
        error: unreachable ? 'sql_unreachable' : 'report_failed',
        message: unreachable
          ? 'Could not reach zRetailHQ0 from the server.'
          : 'The report query failed.',
        detail: redact(message),
        hint: unreachable
          ? 'Vercel functions egress from a wide, changing IP pool. If the firewall in front ' +
            'of the SQL Server allows only known addresses, it cannot connect.'
          : 'Check /api/reports/selftest for which query broke.',
      });
    }
  };
}
