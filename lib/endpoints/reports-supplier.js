import { reportEndpoint } from '../report-handler.js';
import { supplierDetail } from '../reports.js';

export default reportEndpoint(async ({ period, params }) =>
  ({ supplier: await supplierDetail({ alias: params.alias, from: period.from, to: period.to }) }));
