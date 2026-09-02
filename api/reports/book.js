import { reportEndpoint } from '../../lib/report-handler.js';
import { supplierBook } from '../../lib/reports.js';

export default reportEndpoint(async ({ period, params }) => {
  const suppliers = await supplierBook({ from: period.from, to: period.to, limit: params.limit });
  return { count: suppliers.length, suppliers };
});
