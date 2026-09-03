/**
 * Loads the portal's script the way a browser does and renders every view.
 *
 * This exists because two top-level declarations - `sq` and `supPick` - were
 * silently deleted while nearby functions were rewritten, and each threw
 * "X is not defined" on the first paint. Nothing in a syntax check or an API
 * test could see it: the file parses perfectly and the failure only happens
 * when a view is rendered.
 *
 * A stub DOM is enough. The point is not to verify layout, it is that every
 * view can be built without reaching for something that does not exist.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(ROOT, 'assets', 'MB-Buyers-Portal.html'), 'utf8');

const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.equal(blocks.length, 2, 'expected the identity slot and the app script');

/** Just enough DOM for the script to load and paint. */
function makeElement(id) {
  const el = {
    id, innerHTML: '', textContent: '', value: '', hidden: false,
    className: '', style: {}, scrollTop: 0, dataset: {},
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, click() {},
    appendChild() {}, removeChild() {}, insertBefore() {}, remove() {},
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  };
  return el;
}

function makeContext() {
  const nodes = new Map();
  const document = {
    readyState: 'complete',
    documentElement: makeElement('html'),
    body: makeElement('body'),
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, makeElement(id));
      return nodes.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (t) => makeElement(t),
    addEventListener() {},
    head: makeElement('head'),
  };

  const ctx = {
    console,
    document,
    navigator: { userAgent: 'node-test', language: 'en-IN' },
    location: { href: 'http://localhost/portal', search: '', pathname: '/portal' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: () => 0,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    Image: function () {},
    FileReader: function () {},
    URL, URLSearchParams, Math, JSON, Date, RegExp, Promise,
    Object, Array, String, Number, Boolean, Map, Set, Error, isNaN,
    parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

const VIEWS = [
  'home', 'buy', 'book', 'plan', 'watch', 'queue', 'newpo', 'dept', 'polist',
  'approvals', 'msgs', 'inbox', 'suppliers', 'orders', 'money', 'trips', 'report',
];

test('the portal script loads without a missing declaration', () => {
  const ctx = makeContext();
  vm.runInContext(blocks[0], ctx, { filename: 'identity-slot.js' });
  vm.runInContext(blocks[1], ctx, { filename: 'MB-Buyers-Portal.js' });
  assert.equal(typeof vm.runInContext('typeof paint', ctx), 'string');
  assert.equal(vm.runInContext('typeof paint', ctx), 'function');
});

test('every view renders without a ReferenceError', () => {
  const ctx = makeContext();
  vm.runInContext(blocks[0], ctx);
  vm.runInContext(blocks[1], ctx);

  const failures = [];
  for (const view of VIEWS) {
    try {
      vm.runInContext(`view=${JSON.stringify(view)}; paint();`, ctx);
    } catch (err) {
      failures.push(`${view}: ${err.name}: ${err.message}`);
    }
  }
  assert.deepEqual(failures, [], `views that threw:\n  ${failures.join('\n  ')}`);
});

test('the header and the period sheet render for every period', () => {
  const ctx = makeContext();
  vm.runInContext(blocks[0], ctx);
  vm.runInContext(blocks[1], ctx);

  const failures = [];
  for (const p of ['yday', 'week', 'd7', 'd30', 'month', 'last', 'fy', 'range']) {
    try {
      vm.runInContext(`per=${JSON.stringify(p)}; header(); sheet(); liveRange(); liveRangeLabel();`, ctx);
    } catch (err) {
      failures.push(`${p}: ${err.name}: ${err.message}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('the order review and saved screens render, including for a live-only supplier', () => {
  const ctx = makeContext();
  vm.runInContext(blocks[0], ctx);
  vm.runInContext(blocks[1], ctx);

  // A supplier the sample data has never heard of - the case that used to
  // throw, because poView read D[alias] straight.
  vm.runInContext(`
    startPO('BRAND-NEW-SUPPLIER');
    // Shaped as the capture flow builds them, plus one with no photograph at
    // all - a line without pics used to throw on L.pics.length.
    poDraft.lines = [
      { design:'A1', colours:['PINK'], sizes:{ L: 5 }, rate: 700, pics: [] },
      { design:'A2', colours:['RAMA GREEN'], sizes:{ M: 3 }, rate: 820 }
    ];
    view='po'; paint();
  `, ctx);

  vm.runInContext(`
    poSave = { status:'saved', error:null, sheet:{ ok:false, error:'no permission' },
               order:{ orderNo:'MBZ/X/2609/001', supplier_alias:'BRAND-NEW-SUPPLIER',
                       total_qty:5, order_date:'2026-09-03', wanted_by:'2026-09-24',
                       raised_by:'a@b.co', raised_by_name:'A B' } };
    view='posaved'; paint();
  `, ctx);

  assert.ok(vm.runInContext(`typeof poSavedView === 'function'`, ctx));
});

test('the sign-out handler and settings sheet exist and run', () => {
  const ctx = makeContext();
  vm.runInContext(blocks[0], ctx);
  vm.runInContext(blocks[1], ctx);
  assert.equal(vm.runInContext('typeof window.mbSignOut', ctx), 'function');
  vm.runInContext('openSettings();', ctx);
});
