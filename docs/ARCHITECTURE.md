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

## Two tables, two owners

This matters more than it sounds.

| Table | Owner | This app |
|---|---|---|
| `portal_users` | this app | creates, migrates, writes |
| `login_audit` | this app | creates, migrates, writes |
| `employees` | the business (HR) | **reads only** |

`employees` is the HR directory, with its own columns - `emp_code`,
`emp_name`, `emp_mobile`, `emp_designation`, `hod`. An earlier version of
`lib/db.js` treated it as the app's own sign-in table and ran
`ALTER TABLE ... ADD COLUMN` against it, which is not the app's call to make.
Every migration is now guarded by `OWNED_TABLES`, so it cannot happen by
accident again.

`lib/hr-directory.js` reads that table instead of reshaping it. It detects
which column means what (`emp_name` -> name, `emp_designation` ->
designation, and so on) and reads only what it needs. Override any guess with
`HR_TABLE`, `HR_COL_EMAIL`, `HR_COL_NAME`, `HR_COL_DESIGNATION`,
`HR_COL_CODE`, `HR_COL_DEPARTMENT`, `HR_COL_ACTIVE`.

Sign-in is by email address, so a row with no valid email cannot become a
sign-in. Those rows are skipped and counted rather than guessed at, and
`/api/admin/bootstrap` reports how many and which.

`GET /api/admin/inspect` (same `BOOTSTRAP_TOKEN` guard) reports every table,
its columns and row counts, and which column it detected as the email - names
and counts only, never row values, because that table holds personal data.

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

## The reporting views

Four views in zRetailHQ0, one shared grain. `lib/reports.js` builds every
query from these declarations rather than from hand-written SQL, so the set of
columns this app depends on is stated once and nothing can quietly reach for a
column that was not agreed.

| View | Purpose | Date | Measures |
|---|---|---|---|
| `VW_MB_POWERBI_PUR_REPORT` | purchases | `PurchaseDt` | `PurQty`, `PurNetAmount` |
| `VW_MB_POWERBI_PRT_REPORT` | purchase returns | `PurReturnDt` | `PrtQty`, `PrtNetAmount` |
| `VW_MB_POWERBI_SLS_DATA_WITHOUT_ITEMID` | sales | `CashmemoDt` | `SalesQuantity`, `SalesNetAmount` |
| `VW_MB_AI_DSB_REPORT` | inventory | none | `BalQty`, `BalCostValue` |

Shared dimensions, and the only ones any query may group by: `ArticleNo`,
`CategoryShortName`, `SupplierAlias`.

`FabricShortName` was specified but the server rejects it - `Invalid column
name`. Fabric is therefore off, not deleted: set `SQL_COL_FABRIC` to the real
column name and every fabric breakdown returns with no other change.

**Stock is read, not derived.** An earlier version computed it as purchased
minus supplier returns minus sold-ever, because no stock source had been
identified. That was only ever as good as the views' history was complete.
`BalQty` is the real figure and replaces it.

**Sales use `SalesQuantity`.** The sales view also carries `SLSQty`/`SLRQty`,
and an earlier version computed net as the difference because it was not known
whether `SalesQuantity` was gross or net. The agreed column is
`SalesQuantity`, so that is what is read and the pair is not touched.

**Columns are verified, not assumed.** Two different column lists have been
supplied for these same views, so `GET /api/reports/columns` reads what the
server actually has and names anything missing - a clear answer instead of
`Invalid column name` surfacing from a query. `verifyColumns()` also runs as
part of `/api/reports/selftest`.

Reads use `READ UNCOMMITTED` unless `SQL_NOLOCK=false`: this is a live retail
database and a scan holding locks would sit in front of the tills. The cost is
that a figure can move by whatever is mid-transaction at that instant.

### Endpoints

| Path | What |
|---|---|
| `/api/reports/home` | the home tiles: sold, purchased, returned, in stock |
| `/api/reports/best-sellers` | articles by sales, with stock and cover beside each |
| `/api/reports/daily?of=sales` | a daily series for any dated view |
| `/api/reports/book` | every supplier across all four views |
| `/api/reports/supplier?alias=X` | one supplier in detail |
| `/api/reports/breakdown?by=category&of=sales` | any view by any of the four dimensions |
| `/api/reports/columns` | what the app reads vs what the server has |
| `/api/reports/selftest` | every query run once, with timings |

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
| `TEAMS` | desks | fallback roster when the HR table has no emails |
| `INBOX`, `APPROVALS`, `TEAMMSG` | workflow | needs write-side tables |
