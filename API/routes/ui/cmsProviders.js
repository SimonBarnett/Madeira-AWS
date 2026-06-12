// ====================== routes/ui/cmsProviders.js ======================
const { logger, getDbConnection, sql } = require('/opt/nodejs/helpers');

module.exports = async (event) => {
    let pool;
    try {
        pool = await getDbConnection();
        const httpMethod = event.httpMethod;
        const path = event.path;
        const pathParameters = event.pathParameters || {};

        logger.debug('Received event', { event });

        const decoded = event.decoded;
        const userId = decoded.user_id;

        // ====================== GET /cms-providers ======================
        if (httpMethod === 'GET' && path.match(/^\/cms-providers(\/[0-9]+)?$/)) {
            const providerId = pathParameters.id ? parseInt(pathParameters.id, 10) : null;

            let query = `
                SELECT 
                    p.id,
                    p.Comment,
                    p.Icon,
                    p.Description
                FROM dbo.cmsProvider p
            `;
            const params = [];

            if (providerId) {
                query += ` WHERE p.id = @providerId`;
                params.push({ name: 'providerId', type: sql.Int, value: providerId });
            }
            query += ` ORDER BY p.Comment`;

            const providerRequest = pool.request();
            params.forEach(param => {
                providerRequest.input(param.name, param.type, param.value);
            });

            const providersResult = await providerRequest.query(query);
            const providers = providersResult.recordset;

            // Fetch documentation links for each provider
            for (let provider of providers) {
                const linksResult = await pool.request()
                    .input('cmsProviderId', sql.Int, provider.id)
                    .query(`
                        SELECT Title, Link
                        FROM dbo.cmsDocLinks
                        WHERE cmsProviderId = @cmsProviderId
                        ORDER BY Title
                    `);
                provider.docLinks = linksResult.recordset || [];
            }

            if (providerId && providers.length === 0) {
                return {
                    statusCode: 404,
                    body: { message: 'Provider not found' }
                };
            }

            return {
                statusCode: 200,
                body: providers
            };
        }

        // Unsupported method or path
        return {
            statusCode: 405,
            body: { error: 'Method not allowed or path not found' }
        };

    } catch (err) {
        logger.error('Error in cmsProviders handler', { error: err.message, stack: err.stack });
        return {
            statusCode: err.message.includes('Unauthorized') ? 401 : 500,
            body: { error: err.message || 'Internal server error' }
        };
    } finally {
        if (pool) await pool.close();
    }
};