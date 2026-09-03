import { reportEndpoint } from '../report-handler.js';
import { departmentSplit } from '../reports.js';

export default reportEndpoint(async ({ period }) => {
  const rows = await departmentSplit({ from: period.from, to: period.to });
  return { count: rows.length, departments: rows };
});
