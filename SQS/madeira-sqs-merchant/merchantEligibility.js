// merchantEligibility.js
const { sql, executeWithRetry, logger } = require('/opt/nodejs/helpers');

/**
 * Single source of truth for merchant eligibility.
 * Always processes in Id order. Age filter is controlled only by minAgeHours.
 */
async function getEligibleMerchants(pool, options = {}) {
  const {
    lastId = 0,
    minAgeHours = 48,
    countOnly = false
  } = options;

  const eligibilityWhere = `
    WHERE api_key_data IS NOT NULL 
      AND api_key_data != ''
      AND (
        LastStatus = 0 
        OR LastStatus IS NULL
        OR updated_at IS NULL
        OR (LastStatus = 200 AND updated_at < DATEADD(hour, -@minAgeHours, GETDATE()))
        OR (LastStatus NOT IN (200, 0) AND updated_at < DATEADD(hour, -23, GETDATE()))
      )
  `;

  const request = pool.request()
    .input('minAgeHours', sql.Int, minAgeHours);

  let query;

  if (countOnly) {
    query = `
      SELECT COUNT(*) AS Remaining
      FROM UserApiKeys
      ${eligibilityWhere}
    `;
  } else {
    query = `
      SELECT TOP 1 Id, user_id, Description, api_key_type
      FROM UserApiKeys
      ${eligibilityWhere}
        AND Id > @lastId
      ORDER BY Id ASC
    `;
    request.input('lastId', sql.Int, lastId);
  }

  const result = await executeWithRetry(
    () => request.query(query),
    { maxRetries: 3, logger }
  );

  if (countOnly) {
    return { hasMore: result.recordset[0]?.Remaining > 0 };
  }

  return result.recordset[0] || null;
}

module.exports = { getEligibleMerchants };