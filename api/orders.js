import { dispatcher } from '../lib/dispatch.js';
import create from '../lib/endpoints/orders-create.js';
import list from '../lib/endpoints/orders-list.js';
import capture from '../lib/endpoints/orders-capture.js';
import sheet from '../lib/endpoints/orders-sheet-status.js';

/** GET /api/orders lists; POST /api/orders/create raises one. */
export default dispatcher(
  { index: list, list, create, capture, sheet },
  { param: 'action', family: 'orders' }
);
