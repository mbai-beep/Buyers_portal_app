# Meena Bazaar — The Buyer's Portal

The buying and merchandising app for the Meena Bazaar buyers team: a login
screen, a Turso-backed employee directory, and the portal itself gated behind a
signed session. Deployed on Vercel.

```
public/index.html                 login screen (MBZ.IN / Meena Bazaar)
assets/MB-Buyers-Portal.html      the portal SPA — served only to a signed-in employee
api/auth/*                        login, logout, me, change-password
api/portal.js                     the gate
api/employees.js                  employee directory
api/admin/bootstrap.js            one-time schema + roster install
api/health, api/health/sql        readiness probes
lib/                              session, passwords, Turso client, SQL Server pool
scripts/                          schema init, seeding, local dev server, schema dumps
test/                             the login flow, end to end, no network needed
```

`docs/ARCHITECTURE.md` explains why things are arranged this way.
`docs/DEPLOY.md` is the deployment runbook.

## Signing in

Username is the employee's official email address. The first time, the password
is `MBZ` followed by that address:

```
chetna@mbindia.net   →   MBZchetna@mbindia.net
```

That credential works exactly once. The portal then makes them choose a real
password (10+ characters, a letter and a number), which is stored as a salted
scrypt hash. `MBZ<email>` stops working from then on.

## Running it locally

```bash
npm install
cp .env.example .env.local        # a local run needs no Turso account
```

For `.env.local`, the shortest thing that works:

```
SESSION_SECRET=any-48-random-bytes-will-do-just-make-it-long
TURSO_DATABASE_URL=file:local.db
PORTAL_ADMIN_EMAILS=mbai@mbindia.net
```

Then:

```bash
npm run db:init                   # create the tables
npm run db:seed -- --dry-run      # see who would be added
npm run db:seed                   # add them
npm run dev                       # http://localhost:3000
```

The employee list is read out of the SPA's own `TEAMS` and `V2` constants
(`lib/roster.js`), so the directory matches what the portal already displays.

If your network cannot reach `*.turso.io`, seed from the deployment instead —
set `BOOTSTRAP_TOKEN`, `POST /api/admin/bootstrap` once, then delete the
variable. `docs/DEPLOY.md` has the detail.

## Tests

```bash
npm test
```

Runs the whole login path against a throwaway SQLite file: unknown email, wrong
password, first login on the issued credential, the forced password change, the
issued credential going dead afterwards, cookie gating of `/portal`, forged
cookies, and the lockout after repeated failures. No network, no Turso account.

## Data

Two stores:

- **Turso (libSQL)** — `employees` and `login_audit`. Everything the login path
  touches.
- **SQL Server `zRetailHQ0`** — the trading data. Wired up in `lib/sql.js` and
  reachable at `/api/health/sql`; the portal's fifteen data constants are still
  baked into the SPA, listed in `docs/ARCHITECTURE.md` as the queue for
  phase 2.

To capture the schema those queries need:

```bash
npm run sql:check -- --dump              # from anywhere that can reach the server
# or, on Windows:
.\scripts\dump-sqlserver-schema.ps1 -Password '...'
```

## Environment

See `.env.example`. Nothing secret is committed; `.env.local` and the schema
dumps are gitignored.
