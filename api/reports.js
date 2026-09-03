import { dispatcher } from '../lib/dispatch.js';
import home from '../lib/endpoints/reports-home.js';
import bestSellers from '../lib/endpoints/reports-best-sellers.js';
import daily from '../lib/endpoints/reports-daily.js';
import book from '../lib/endpoints/reports-book.js';
import supplier from '../lib/endpoints/reports-supplier.js';
import departments from '../lib/endpoints/reports-departments.js';
import reconcile from '../lib/endpoints/reports-reconcile.js';
import selftest from '../lib/endpoints/reports-selftest.js';

export default dispatcher({
  index: home,
  home,
  'best-sellers': bestSellers,
  daily,
  book,
  supplier,
  departments,
  reconcile,
  selftest,
}, { param: 'report', family: 'reports' });
