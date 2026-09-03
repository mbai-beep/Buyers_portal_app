import { reportEndpoint } from '../report-handler.js';
import { selftest } from '../reports.js';

export default reportEndpoint(async ({ period }) =>
  ({ selftest: await selftest({ from: period.from, to: period.to }) }));
