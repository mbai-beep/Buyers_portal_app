#!/usr/bin/env node
/**
 * Refuses to let a credential reach the repository.
 *
 * Scans what git is about to record - the staged content, not the working
 * tree - because that is the last cheap moment to catch a secret. Once a
 * commit exists on a public remote, removing it means rewriting history and
 * rotating the credential anyway.
 *
 *   node scripts/check-secrets.mjs            # staged changes (pre-commit hook)
 *   node scripts/check-secrets.mjs --all      # every tracked file at HEAD
 *   node scripts/check-secrets.mjs --history  # every commit, slower
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const mode = process.argv.includes('--history') ? 'history'
           : process.argv.includes('--all') ? 'all'
           : 'staged';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

const RULES = [
  { name: 'libSQL / Turso auth token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'GitHub personal access token',
    re: /\b(gh[posru]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key block',
    re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'Vercel token', re: /\bvercel_[A-Za-z0-9]{20,}\b/ },
  // A populated secret in a committed env template is the mistake this exists for.
  { name: 'populated secret in a committed env file',
    re: /^[ \t]*(TURSO_AUTH_TOKEN|SESSION_SECRET|SQLSERVER_PASSWORD|GITHUB_TOKEN|BOOTSTRAP_TOKEN|VERCEL_TOKEN)[ \t]*=[ \t]*\S+/m,
    onlyIn: /(^|\/)\.env(\.[A-Za-z0-9]+)*$/ },
];

/** Files allowed to discuss credentials without holding one. */
const ALLOW = [
  /(^|\/)scripts\/check-secrets\.mjs$/,
  /(^|\/)lib\/passwords\.js$/,
  /(^|\/)test\//,
];

const findings = [];

function record(file, text, rule) {
  const m = text.match(rule.re);
  if (!m) return;
  findings.push({
    file,
    line: text.slice(0, m.index).split('\n').length,
    rule: rule.name,
    sample: m[0].slice(0, 12),
  });
}

function scan(file, text) {
  if (!text) return;
  for (const rule of RULES) {
    if (rule.onlyIn) { if (rule.onlyIn.test(file)) record(file, text, rule); continue; }
    if (ALLOW.some((re) => re.test(file))) continue;
    record(file, text, rule);
  }
}

function listFiles() {
  const out = mode === 'staged'
    ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR')
    : git('ls-files');
  return out.split('\n').filter(Boolean);
}

/**
 * Reading HEAD in --all mode silently skipped files added since the last
 * commit - exactly the files most likely to be carrying a freshly pasted
 * credential. Read the index first, then the working tree, and only then
 * HEAD; a file that cannot be read at all is reported rather than passed.
 */
const unreadable = [];

function contentOf(file) {
  // --all means "what is on disk right now", so the working tree comes first;
  // reading the index first returned the committed copy and a token pasted
  // into a tracked file went unnoticed. --staged means exactly the index.
  for (const attempt of mode === 'staged'
    ? [() => git('show', `:${file}`)]
    : [() => readFileSync(file, 'utf8'), () => git('show', `:${file}`), () => git('show', `HEAD:${file}`)]) {
    try {
      const text = attempt();
      if (typeof text === 'string') return text;
    } catch { /* try the next source */ }
  }
  unreadable.push(file);
  return '';
}

if (mode === 'history') {
  for (const rev of git('rev-list', '--all').split('\n').filter(Boolean)) {
    for (const rule of RULES) {
      let out = '';
      // -e matters: the private-key pattern starts with '-' and git would
      // otherwise read it as an option.
      try { out = git('grep', '-I', '-n', '-E', '-e', rule.re.source, rev); } catch { continue; }
      for (const hit of out.split('\n').filter(Boolean).slice(0, 5)) {
        const m = hit.match(/^[^:]+:([^:]+):(\d+):/);
        if (!m) continue;
        const [, file, line] = m;
        if (rule.onlyIn ? !rule.onlyIn.test(file) : ALLOW.some((re) => re.test(file))) continue;
        findings.push({ file: `${rev.slice(0, 8)}:${file}`, line, rule: rule.name, sample: '' });
      }
    }
  }
} else {
  for (const file of listFiles()) scan(file, contentOf(file));
}

if (unreadable.length) {
  console.error(`check-secrets: could not read ${unreadable.length} file(s), so they were NOT scanned:`);
  for (const f of unreadable.slice(0, 20)) console.error(`  ${f}`);
  process.exit(1);
}

if (!findings.length) {
  console.log(`check-secrets: clean (${mode})`);
  process.exit(0);
}

console.error(`\ncheck-secrets: refusing to continue - ${findings.length} finding(s)\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${f.rule}${f.sample ? `  (starts "${f.sample}…")` : ''}`);
}
console.error(`
Real values belong in .env.local (gitignored) and in the Vercel environment,
never in a committed file. Move them and commit again.

False positive? Add the file to ALLOW in scripts/check-secrets.mjs, with a
comment saying why.
`);
process.exit(1);
