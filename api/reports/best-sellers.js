import { reportEndpoint } from '../../lib/report-handler.js';
import { bestSellers } from '../../lib/reports.js';

export default reportEndpoint(async ({ period, params }) => {
  const rows = await bestSellers({ from: period.from, to: period.to, limit: params.limit });
  return { count: rows.length, articles: rows };
});
