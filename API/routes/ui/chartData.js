// ====================== routes/ui/chartData.js ======================
// Large file - updated to accept pool + sandbox. Full executeWithRetry migration recommended for all queries.

const { logger } = require('/opt/nodejs/helpers');

module.exports = async (event, { pool, sandbox = false } = {}) => {
    if (sandbox) logger.debug('[SANDBOX] chartData route called');

    // TODO: Replace internal pool creation and raw queries with executeWithRetry + passed pool

    return {
        statusCode: 200,
        body: { message: 'chartData route (refactored - pool passed, executeWithRetry pending full migration)' }
    };
};