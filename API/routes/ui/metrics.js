// ====================== routes/ui/metrics.js ======================
const { logger, executeWithRetry, sql } = require('/opt/nodejs/helpers');

module.exports = async (event, { pool, sandbox = false } = {}) => {
    try {
        // Example: replace raw queries with executeWithRetry
        const result = await executeWithRetry(() =>
            pool.request().query('SELECT COUNT(*) as total FROM SomeMetricsTable')
        );

        if (sandbox) logger.debug('[SANDBOX] metrics route executed');

        return {
            statusCode: 200,
            body: { metrics: result.recordset[0] || {} }
        };
    } catch (error) {
        logger.error('Error in metrics route', { error: error.message });
        return { statusCode: 500, body: { error: 'Failed to fetch metrics' } };
    }
};