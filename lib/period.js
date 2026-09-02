/** Shared period parsing for the reporting endpoints. */
import { financialYearStart, isoDate } from './reports.js';

const DAY = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);

export function resolvePeriod(params = {}) {
  const today = process.env.REPORT_TODAY || iso(new Date());

  if (params.from && params.to) {
    const from = isoDate(params.from);
    const to = isoDate(params.to);
    if (from > to) throw new Error('"from" is after "to"');
    return { from, to, label: `${from} to ${to}` };
  }

  const back = (n) => iso(new Date(Date.parse(`${today}T00:00:00Z`) - n * DAY));

  switch (params.period || 'd30') {
    case 'd1':  return { from: today, to: today, label: 'today' };
    case 'd7':  return { from: back(6), to: today, label: 'last seven days' };
    case 'd30': return { from: back(29), to: today, label: 'last thirty days' };
    case 'd90': return { from: back(89), to: today, label: 'last ninety days' };
    case 'mtd': return { from: `${today.slice(0, 7)}-01`, to: today, label: 'this month' };
    case 'fy':  return { from: financialYearStart(new Date(`${today}T00:00:00Z`)), to: today,
                         label: 'this financial year' };
    default:    throw new Error(`unknown period "${params.period}" - use d1, d7, d30, d90, mtd, fy, or from/to`);
  }
}

export function queryParams(req) {
  const url = new URL(req.url || '/', 'http://x');
  return Object.fromEntries(url.searchParams);
}
