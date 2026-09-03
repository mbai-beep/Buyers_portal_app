import { reportEndpoint } from '../report-handler.js';
import { dailySales } from '../reports.js';

export default reportEndpoint(async ({ period }) => {
  const days = await dailySales({ from: period.from, to: period.to });
  return { count: days.length, days };
});
