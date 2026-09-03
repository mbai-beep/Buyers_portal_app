import { reportEndpoint } from '../report-handler.js';
import { verifyColumns, requiredColumns } from '../reports.js';

/**
 * What this app reads from each view, checked against what the server has.
 * Replaces guessing when a column list and a database disagree.
 */
export default reportEndpoint(async () => {
  const verification = await verifyColumns();
  return { required: requiredColumns(), verification };
}, { needsPeriod: false });
