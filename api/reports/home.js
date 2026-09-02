import { reportEndpoint } from '../../lib/report-handler.js';
import { homeTotals } from '../../lib/reports.js';

export default reportEndpoint(async ({ period }) =>
  ({ home: await homeTotals({ from: period.from, to: period.to }) }));
