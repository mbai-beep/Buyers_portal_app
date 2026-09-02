# Deploying the Buyer's Portal

## 1. GitHub

The repository is pushed from the project folder:

```bash
git remote -v            # confirm the origin
git push -u origin main
```

## 2. Vercel

1. <https://vercel.com/new> → **Import Git Repository** → pick this repo.
2. Framework preset: **Other**. Leave build command empty, output directory `public`.
   Vercel picks up `api/` as serverless functions and `vercel.json` for the rewrites.
3. Before the first deploy, add the environment variables below
   (Settings → Environment Variables, all three environments).
4. Deploy.

## 3. Environment variables

| Name | Value | Notes |
|---|---|---|
| `SESSION_SECRET` | 48 random bytes | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` — changing it signs everyone out |
| `TURSO_DATABASE_URL` | `libsql://<db>-<org>.turso.io` | from `turso db show <db> --url` |
| `TURSO_AUTH_TOKEN` | Turso token | `turso db tokens create <db>` |
| `SQLSERVER_HOST` | `38.45.94.39` | |
| `SQLSERVER_PORT` | `12866` | |
| `SQLSERVER_USER` | `zorderai` | |
| `SQLSERVER_PASSWORD` | *(the real password)* | never commit it |
| `SQLSERVER_DATABASE` | `zRetailHQ0` | |
| `SQLSERVER_ENCRYPT` | `true` | |
| `SQLSERVER_TRUST_SERVER_CERTIFICATE` | `true` | the host presents a self-signed certificate |
| `PORTAL_ADMIN_EMAILS` | `mbai@mbindia.net` | comma separated |
| `SESSION_HOURS` | `8` | optional |

## 4. Seeding the directory

Run once from your machine, pointed at the production Turso database:

```bash
cp .env.example .env.local     # fill in TURSO_* and SESSION_SECRET
npm run db:init
npm run db:seed -- --dry-run   # check the list first
npm run db:seed
```

Everyone then signs in the first time with `MBZ` + their email address,
e.g. `MBZchetna@mbindia.net`, and is made to set a real password before the
portal opens.

## 5. Checks after deploy

| URL | Expect |
|---|---|
| `/` | the login screen |
| `/api/health` | `{"ok":true,...,"turso":{"status":"ok","activeEmployees":n}}` |
| `/portal` while signed out | 302 to `/login?next=%2Fportal` |
| `/api/health/sql` while signed in | `{"ok":true,...}` — see below if not |

### If `/api/health/sql` fails

Vercel functions call out from a wide, changing pool of IP addresses. If the
firewall in front of `38.45.94.39:12866` only allows known addresses, the
function cannot connect. Options, best first:

1. Put the database behind a small always-on API on a host you control and
   have Vercel call that.
2. Turn on **Vercel Secure Compute** (a fixed egress IP range) and allow it.
3. Allow Vercel's published egress ranges — broad, and they change.

This does not affect login: that path only needs Turso, which is reached over
HTTPS.
