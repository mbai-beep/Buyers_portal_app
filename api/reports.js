import { dispatcher } from '../lib/dispatch.js';
import home from '../lib/endpoints/reports-home.js';
import bestSellers from '../lib/endpoints/reports-best-sellers.js';
import daily from '../lib/endpoints/reports-daily.js';
import book from '../lib/endpoints/reports-book.js';
import supplier from '../lib/endpoints/reports-supplier.js';
import breakdown from '../lib/endpoints/reports-breakdown.js';
import columns from '../lib/endpoints/reports-columns.js';
import selftest from '../lib/endpoints/reports-selftest.js';

export default dispatcher({
  index: home,
  home,
  'best-sellers': bestSellers,
  daily,
  book,
  supplier,
  breakdown,
  columns,
  selftest,
}, { param: 'report', family: 'reports' });
