import { reportEndpoint } from '../report-handler.js';
import { daily } from '../reports.js';

export default reportEndpoint(async ({ period, params }) => {
  const of = params.of || 'sales';
  const days = await daily(of, { from: period.from, to: period.to });
  return { of, count: days.length, days };
});
