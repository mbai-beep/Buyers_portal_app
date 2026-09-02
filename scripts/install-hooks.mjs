#!/usr/bin/env node
/** Installs the pre-commit secret scan. Run once per clone: npm run hooks */
import { writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

if (!existsSync('.git')) {
  console.error('Not a git repository - run this from the project root.');
  process.exit(1);
}

const dir = path.join('.git', 'hooks');
mkdirSync(dir, { recursive: true });

const file = path.join(dir, 'pre-commit');
writeFileSync(file, `#!/bin/sh
# Installed by scripts/install-hooks.mjs - blocks commits containing credentials.
node scripts/check-secrets.mjs || exit 1
`, 'utf8');
try { chmodSync(file, 0o755); } catch { /* filesystem without exec bits */ }

console.log(`Installed ${file}`);
console.log('Commits are now scanned for credentials before they are recorded.');
