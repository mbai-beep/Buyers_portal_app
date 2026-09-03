import { dispatcher } from '../lib/dispatch.js';
import health from '../lib/endpoints/health-index.js';
import sqlHealth from '../lib/endpoints/health-sql.js';

export default dispatcher(
  { index: health, health, sql: sqlHealth },
  { param: 'check', family: 'health' }
);
