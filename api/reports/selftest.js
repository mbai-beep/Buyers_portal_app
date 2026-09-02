import { reportEndpoint } from '../../lib/report-handler.js';
import { selftest, describeViews } from '../../lib/reports.js';

/**
 * Runs every reporting query over the requested window and reports which
 * worked, how long each took and a sample row - one call to validate the
 * whole layer against the real server.
 *
 * Defaults to the last seven days: enough to have data, short enough not to
 * sit on a live retail database.
 */
export default reportEndpoint(async ({ period }) => ({
  views: await describeViews(),
  selftest: await selftest({ from: period.from, to: period.to }),
}));
