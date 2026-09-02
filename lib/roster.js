/**
 * Reads the employee roster out of the portal SPA's own TEAMS and V2
 * constants, so the Turso directory matches what the app already displays
 * rather than a second hand-typed list that drifts from it.
 *
 * Used by scripts/seed-employees.mjs and by api/admin/bootstrap.js.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Pulls one top-level `const NAME = <literal>;` out of the SPA. */
function grabConst(src, name) {
  const at = src.indexOf(`const ${name} = `);
  if (at < 0) return null;
  const start = src.indexOf('=', at) + 1;
  let depth = 0, inString = null, i = start;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'") { inString = c; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ';' && depth === 0) break;
  }
  // A JSON-ish object literal from a file in this repo, not user input.
  return Function(`"use strict";return (${src.slice(start, i)});`)();
}

export function portalPath() {
  return path.join(process.cwd(), 'assets', 'MB-Buyers-Portal.html');
}

export function readRoster(file = portalPath()) {
  const src = readFileSync(file, 'utf8');
  const TEAMS = grabConst(src, 'TEAMS') || {};
  const V2 = grabConst(src, 'V2') || {};

  const byEmail = new Map();
  const conflicts = [];
  const reported = new Set();

  const add = (rec) => {
    const email = String(rec.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return;

    const existing = byEmail.get(email);
    if (existing) {
      if (existing.name !== rec.name) {
        // Two different people on one address is a data problem worth naming.
        const seen = `${email}|${rec.name}`;
        if (!reported.has(seen)) {
          reported.add(seen);
          conflicts.push({ email, kept: existing.name, ignored: rec.name });
        }
      }
      // The per-supplier contact cards carry fuller job titles than the desk
      // rosters ("Head of Buying & Merchandising" vs "Head of buying"), so the
      // more specific one wins.
      if ((rec.designation || '').length > (existing.designation || '').length) {
        existing.designation = rec.designation;
      }
      existing.department ||= rec.department;
      existing.desk ||= rec.desk;
      if (rec.role === 'admin') existing.role = 'admin';
      return;
    }
    byEmail.set(email, { ...rec, email });
  };

  for (const [head, team] of Object.entries(TEAMS)) {
    for (const p of team.people || []) {
      add({ name: p.n, email: p.e, designation: p.r, department: head, desk: team.team, role: 'buyer' });
    }
  }
  for (const v of Object.values(V2)) {
    for (const p of v.team || []) {
      add({ name: p.name, email: p.email, designation: p.designation,
            department: null, desk: p.role || null, role: 'buyer' });
    }
  }
  for (const raw of String(process.env.PORTAL_ADMIN_EMAILS || '').split(',')) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (byEmail.has(e)) { byEmail.get(e).role = 'admin'; continue; }
    add({ name: 'Portal Administrator', email: e, designation: 'IT / Portal Administrator',
          department: 'IT', desk: 'Portal administration', role: 'admin' });
  }

  return { people: [...byEmail.values()], conflicts };
}
