import { reportEndpoint } from '../report-handler.js';
import { reconcileSales } from '../reports.js';

/**
 * Settles what SalesQuantity / SalesNetAmount mean in the sales view, by
 * putting all three quantity readings side by side over the same period.
 */
export default reportEndpoint(async ({ period }) =>
  ({ reconciliation: await reconcileSales({ from: period.from, to: period.to }) }));
