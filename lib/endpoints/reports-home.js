import { reportEndpoint } from '../report-handler.js';
import { homeTotals } from '../reports.js';

export default reportEndpoint(async ({ period }) =>
  ({ home: await homeTotals({ from: period.from, to: period.to }) }));
