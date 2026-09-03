import { reportEndpoint } from '../report-handler.js';
import { supplierBook } from '../reports.js';

export default reportEndpoint(async ({ period, params }) => {
  const suppliers = await supplierBook({ from: period.from, to: period.to, limit: params.limit });
  return { count: suppliers.length, suppliers };
});
