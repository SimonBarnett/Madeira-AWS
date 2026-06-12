// nodejs/conf/db-config.js
const sql = require('mssql');
const { SSMClient, GetParametersCommand } = require("@aws-sdk/client-ssm");

let pool = null;
let configCache = null;
let configCacheTime = 0;

function getEnvInt(name, defaultValue) {
  const val = process.env[name];
  return val ? parseInt(val, 10) : defaultValue;
}

async function getDbConfig() {
  const now = Date.now();
  if (configCache && (now - configCacheTime < 30 * 60 * 1000)) {
    return configCache;
  }

  const ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'eu-west-2' });

  const command = new GetParametersCommand({
    Names: [
      "/madeira/db/user",
      "/madeira/db/password",
      "/madeira/db/server",
      "/madeira/db/name"
    ],
    WithDecryption: true
  });

  const response = await ssmClient.send(command);
  const params = {};
  response.Parameters.forEach(p => {
    params[p.Name.split('/').pop()] = p.Value;
  });

  const config = {
    user: process.env.DB_USER || params.user || "madeira_app",
    password: process.env.DB_PASSWORD || params.password,
    server: process.env.DB_SERVER || params.server,
    database: process.env.DB_NAME || params.name,
    port: 1433,

    options: {
      encrypt: true,
      trustServerCertificate: true,
      enableArithAbort: true,
    },

    pool: {
      min: getEnvInt('DB_POOL_MIN', 2),
      max: getEnvInt('DB_POOL_MAX', 25),
      idleTimeoutMillis: getEnvInt('DB_IDLE_TIMEOUT_MS', 30000),
      acquireTimeoutMillis: getEnvInt('DB_ACQUIRE_TIMEOUT_MS', 30000),
      createTimeoutMillis: getEnvInt('DB_CREATE_TIMEOUT_MS', 30000),
      destroyTimeoutMillis: getEnvInt('DB_DESTROY_TIMEOUT_MS', 5000),
      reapIntervalMillis: getEnvInt('DB_REAP_INTERVAL_MS', 1000),
    },

    connectionTimeout: getEnvInt('DB_CONNECTION_TIMEOUT_MS', 30000),
    requestTimeout: getEnvInt('DB_REQUEST_TIMEOUT_MS', 30000),
  };

  configCache = config;
  configCacheTime = now;
  return config;
}

/**
 * Internal connection retry logic (not exported)
 */
async function connectWithRetry(poolInstance, maxRetries = 4) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await poolInstance.connect();
      return;
    } catch (err) {
      const isRetryable =
        err.code === 'ETIMEDOUT' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ESOCKET' ||
        err.message?.toLowerCase().includes('timeout') ||
        err.message?.toLowerCase().includes('connect');

      if (isRetryable && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 800;
        console.warn(`[DB Pool] Connection attempt ${attempt}/${maxRetries} failed. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
}

async function getDbPool() {
  if (pool) return pool;

  const config = await getDbConfig();
  pool = new sql.ConnectionPool(config);

  try {
    await connectWithRetry(pool);           // ← Retry logic is internal
    console.log('[DB Pool] Connected successfully');
  } catch (err) {
    pool = null;
    console.error('[DB Pool] Failed to connect after retries:', err.message);
    throw err;
  }

  pool.on('error', err => {
    console.error('[DB Pool] Pool error:', err);
  });

  return pool;
}

async function closeDbPool() {
  if (pool) {
    await pool.close();
    pool = null;
  }
}

/* ============================================================
   REUSABLE RETRY UTILITY (for MERGE, queries, etc.)
   ============================================================ */
async function executeWithRetry(fn, options = {}) {
  const {
    maxRetries = 5,
    baseDelay = 800,
    logger = console,
    retryableErrors = [1205, 8645],
    retryableMessages = ['deadlock', 'transaction']
  } = options;

  let lastError;
  let totalRetryTime = 0;
  let retryCount = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();

      if (retryCount > 0 && logger?.info) {
        logger.info(`✅ Operation succeeded after ${retryCount} retries (total retry time: ${totalRetryTime}ms)`);
      }

      return { ...(result || {}), retryCount };
    } catch (err) {
      lastError = err;

      const isRetryable =
        retryableErrors.includes(err.number) ||
        retryableMessages.some(msg => err.message?.toLowerCase().includes(msg));

      if (isRetryable && attempt < maxRetries) {
        retryCount++;
        const delay = Math.pow(2, attempt) * baseDelay;
        totalRetryTime += delay;

        if (logger?.warn) {
          logger.warn(`⚠️ Retryable error (attempt ${attempt}/${maxRetries}). Retrying in ${delay}ms...`, {
            errorCode: err.number,
            message: err.message
          });
        }

        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      throw err;
    }
  }

  throw lastError;
}

module.exports = {
  getDbConfig,
  getDbPool,
  closeDbPool,
  executeWithRetry
};