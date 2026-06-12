// ====================== routes/ui/index.js ======================
// UI Routes Sub-Router
// Called by the main orchestrator
// Last updated: 02 June 2026

const { logger } = require('/opt/nodejs/helpers');

const cmsProvidersHandler = require('./cmsProviders');
const apiKeysHandler = require('./apiKeys');
const metricsHandler = require('./metrics');
const chartDataHandler = require('./chartData');
const merchantPartsHandler = require('./merchantParts');
const categoryHandler = require('./category');
const resetHandler = require('./reset');

module.exports = async (event) => {
    const path = event.path || '/';
    const method = event.httpMethod;
    const decoded = event.decoded;

    logger.debug('UI Router received request', { path, method });

    try {
        if (path.startsWith('/cms-providers')) {
            return await cmsProvidersHandler(event);
        } 
        else if (path.startsWith('/api-keys')) {
            return await apiKeysHandler(event);
        } 
        else if (path === '/metrics' && method === 'GET') {
            return await metricsHandler(event);
        } 
        else if (path === '/chart-data' && method === 'GET') {
            return await chartDataHandler(event);
        } 
        else if (path === '/merchant-parts' && method === 'GET') {
            return await merchantPartsHandler(event);
        } 
        else if (path === '/category' && method === 'GET') {
            const body = event.body ? JSON.parse(event.body) : {};
            const result = await categoryHandler(decoded.user_id, body, method);
            return { statusCode: 200, body: result };
        } 
        else if (path === '/category' && method === 'POST') {
            const body = event.body ? JSON.parse(event.body) : {};
            const result = await categoryHandler(decoded.user_id, body, method);
            return { statusCode: 200, body: result };
        } 
        else if (path === '/category/reset' && method === 'POST') {
            const result = await resetHandler(decoded.user_id);
            return { statusCode: 200, body: result };
        } 
        else {
            logger.warn('UI route not found', { path, method });
            return {
                statusCode: 404,
                body: { message: 'UI route not found' }
            };
        }
    } catch (error) {
        logger.error('Error in UI router', { path, error: error.message });
        return {
            statusCode: 500,
            body: { message: error.message || 'Internal Server Error' }
        };
    }
};