/**
 * zRetailHQ0 (Microsoft SQL Server) connection pool.
 *
 * Phase 1 of this build only uses it for a health check - the portal screens
 * still run on the data baked into the SPA. The pool is here so the reporting
 * endpoints can be added without touching configuration again.
 */
import sql from 'mssql';

let poolPromise = null;

function config() {
  const {
    SQLSERVER_HOST, SQLSERVER_PORT, SQLSERVER_USER,
    SQLSERVER_PASSWORD, SQLSERVER_DATABASE,
  } = process.env;

  const missing = ['SQLSERVER_HOST', 'SQLSERVER_USER', 'SQLSERVER_PASSWORD', 'SQLSERVER_DATABASE']
    .filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`SQL Server config missing: ${missing.join(', ')}`);

  return {
    server: SQLSERVER_HOST,
    port: Number(SQLSERVER_PORT || 1433),
    user: SQLSERVER_USER,
    password: SQLSERVER_PASSWORD,
    database: SQLSERVER_DATABASE,
    options: {
      encrypt: process.env.SQLSERVER_ENCRYPT !== 'false',
      trustServerCertificate: process.env.SQLSERVER_TRUST_SERVER_CERTIFICATE !== 'false',
      enableArithAbort: true,
    },
    pool: { max: 4, min: 0, idleTimeoutMillis: 15000 },
    connectionTimeout: 15000,
    requestTimeout: 30000,
  };
}

export function pool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config()).connect().catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

/**
 * Parameterised query. Pass params as { name: value } or
 * { name: { type: sql.Int, value: 1 } }.
 */
export async function query(text, params = {}) {
  const p = await pool();
  const request = p.request();
  for (const [key, val] of Object.entries(params)) {
    if (val && typeof val === 'object' && 'type' in val) request.input(key, val.type, val.value);
    else request.input(key, val);
  }
  const result = await request.query(text);
  return result.recordset ?? [];
}

export { sql };
