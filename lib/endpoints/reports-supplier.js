import { json } from '../http.js';
import { reportEndpoint } from '../report-handler.js';
import { supplierDetail } from '../reports.js';

export default reportEndpoint(async ({ period, params }) => {
  const alias = String(params.alias || '').trim();
  if (!alias) {
    const err = new Error('an "alias" parameter is required, e.g. /api/reports/supplier?alias=AHD-NIC');
    err.badRequest = true;
    throw err;
  }
  return { supplier: await supplierDetail({ alias, from: period.from, to: period.to }) };
});
