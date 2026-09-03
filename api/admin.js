import { dispatcher } from '../lib/dispatch.js';
import bootstrap from '../lib/endpoints/admin-bootstrap.js';
import inspect from '../lib/endpoints/admin-inspect.js';
import diagnose from '../lib/endpoints/admin-diagnose.js';

export default dispatcher(
  { bootstrap, inspect, diagnose },
  { param: 'action', family: 'admin' }
);
