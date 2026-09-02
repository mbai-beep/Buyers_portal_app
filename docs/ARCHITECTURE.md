# How it fits together

```
browser
  │
  ├─ GET /                       public/index.html         login screen (static, CDN)
  ├─ POST /api/auth/login        api/auth/login.js         Turso lookup → session cookie
  ├─ POST /api/auth/change-password
  ├─ GET  /api/auth/me
  ├─ POST /api/auth/logout
  │
  ├─ GET /portal                 api/portal.js             cookie checked, THEN the SPA
  │                                └─ assets/MB-Buyers-Portal.html
  │
  ├─ GET /api/employees          api/employees.js          Turso directory
  └─ GET /api/health[/sql]       api/health/*              readiness probes
```

## Why the SPA is not in `public/`

Anything under `public/` is served straight off Vercel's CDN, before any
function runs, so a cookie cannot be checked. `assets/MB-Buyers-Portal.html`
is therefore bundled into the `/api/portal` function (`includeFiles` in
`vercel.json`) and only written to the response once the session verifies. The
file is read once per warm instance, not once per request.

## Identity injection

The SPA carries a slot:

```js
window.__MB_USER = /*MB_USER*/null/*MB_USER*/;
```

`api/portal.js` replaces that literal with the signed-in employee as JSON, and
the SPA's `ME` constant reads from it, falling back to its original hard-coded
value when the file is opened directly from disk. So the same file still works
as a standalone demo.

## Passwords

The brief was: everyone's password is `MBZ<their email>`. That is derivable
from a business card, so it is treated as an enrolment credential, not a
password:

1. A new employee row has `password_hash = NULL`.
2. First login accepts `MBZ<email>`, hashes it (scrypt, per-row salt), stores
   it, and sets `must_change_password = 1`.
3. The login screen then makes them set a real password before `/portal` opens.
4. From that point `MBZ<email>` is refused.

`login_audit` records every attempt; eight bad passwords for one address in
fifteen minutes returns 429 instead of checking the ninth.

## Sessions

`mbz_session`: a compact JWT, HS256 over `SESSION_SECRET`, `HttpOnly`,
`Secure`, `SameSite=Lax`, eight hours. Verification is signature plus `exp`,
constant-time compared. There is no server-side session table, so rotating
`SESSION_SECRET` is the way to sign everyone out at once.

## SQL Server

`lib/sql.js` holds a pooled `mssql` connection to `zRetailHQ0`. Phase 1 uses it
only for `/api/health/sql`; the portal screens still run on the data baked into
the SPA. `scripts/check-sqlserver.mjs --dump` and
`scripts/dump-sqlserver-schema.ps1` exist to capture the schema so the
reporting endpoints can be written against real tables.

## What is still hard-coded in the SPA

Fifteen constants, all in `assets/MB-Buyers-Portal.html`, each a candidate for
its own endpoint:

| Constant | Screen | Rough shape |
|---|---|---|
| `D` | supplier detail | per-supplier header figures |
| `ART` | designs | article → colour → size |
| `TOP` | best sellers | article, colour, sold, balance, days |
| `PO` | orders | pending purchase orders and lines |
| `BOOK` | the whole book | 225 suppliers, sold/balance rollups |
| `V2` | supplier extras | size mix, contact team |
| `DAILY` | trend | daily sold series |
| `EX` | returns | returns and exchanges |
| `INVL` | invoices | invoice lines |
| `BILLX` | ledger | bill and receipt dates |
| `TRIPS`, `DIARY` | travel | market visits |
| `TEAMS` | desks | now also seeded into Turso |
| `INBOX`, `APPROVALS`, `TEAMMSG` | workflow | needs write-side tables |
