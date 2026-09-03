import { reportEndpoint } from '../report-handler.js';
import { articleLeaders } from '../reports.js';

export default reportEndpoint(async ({ period, params }) => {
  const articles = await articleLeaders({ from: period.from, to: period.to, limit: params.limit });
  return { count: articles.length, articles };
});
