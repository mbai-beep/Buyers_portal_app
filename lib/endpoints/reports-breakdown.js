import { reportEndpoint } from '../report-handler.js';
import { groupBy, GRAIN } from '../reports.js';

/**
 * Any view, grouped by any of the four shared dimensions.
 *   /api/reports/breakdown?by=category&of=sales&period=d30
 */
export default reportEndpoint(async ({ period, params }) => {
  const by = params.by || 'category';
  const of = params.of || 'sales';
  const rows = await groupBy(of, by, {
    from: period.from, to: period.to, limit: params.limit, order: params.order,
  });
  return { of, by, dimensions: Object.keys(GRAIN), count: rows.length, rows };
});
