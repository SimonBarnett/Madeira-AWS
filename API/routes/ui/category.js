// ====================== routes/ui/category.js ======================
// Category route handler
// Uses clubscan.Status as the single source of truth.
// 'complete' (or *_complete) means that step finished.
// We show categories once we reach a complete state for categories or overall.

const { logger, executeWithRetry, sql, enqueueMessage } = require('/opt/nodejs/helpers');

async function handleCategory(userId, body, method, { pool, sandbox = false } = {}) {
    logger.info('Handling category request', { userId, method });

    if (!userId) {
        return { status: 'error', error_message: 'Invalid user', categories: {}, exclude: [], dialog: 'Error' };
    }

    if (method === 'POST') {
        try {
            await enqueueMessage({
                type: 'CATEGORY_UPDATE',
                userId,
                body,
                sandbox
            });

            if (sandbox) logger.debug('[SANDBOX] CATEGORY_UPDATE enqueued', { userId });

            return { status: 'success' };
        } catch (error) {
            logger.error('Failed to enqueue CATEGORY_UPDATE', { userId, error: error.message });
            return { status: 'error', error_message: 'Failed to process request', categories: {}, exclude: [], dialog: 'Error processing categories.' };
        }
    }

    // GET - driven by clubscan.Status
    if (method === 'GET') {
        try {
            const clubscanResult = await executeWithRetry(() =>
                pool.request()
                    .input('clubId', sql.VarChar, userId)
                    .query(`
                        SELECT TOP 1 Status 
                        FROM clubscan 
                        WHERE ClubID = @clubId 
                        ORDER BY UpdatedAt DESC
                    `)
            );

            const status = (clubscanResult.recordset[0]?.Status || 'not_started').toLowerCase();

            // Still processing
            const processingStates = ['queued', 'generating_categories', 'building_catalog', 'fetching_content', 'processing'];
            if (processingStates.includes(status)) {
                return {
                    status: 'processing',
                    categories: {},
                    exclude: [],
                    dialog: 'We are still processing your community data. Please wait a moment.'
                };
            }

            // Ready to show categories when we hit any 'complete' state
            // (complete, categories_complete, catalog_complete, etc.)
            if (status === 'complete' || status.endsWith('_complete')) {
                const userDataResult = await executeWithRetry(() =>
                    pool.request()
                        .input('uid', sql.VarChar, userId)
                        .query(`
                            SELECT json_categories, json_chat, exclude 
                            FROM UserCategories 
                            WHERE uid = @uid
                        `)
                );

                const userData = userDataResult.recordset[0] || {};
                let categories = {};
                try { categories = JSON.parse(userData.json_categories || '{}'); } catch (e) {}

                return {
                    status: 'success',
                    categories,
                    exclude: userData.exclude || [],
                    dialog: userData.json_chat ? JSON.parse(userData.json_chat).slice(-1)[0]?.dialog || 'Here are your current categories.' : 'Here are your current categories.'
                };
            }

            // Not started or unknown state
            return {
                status: 'success',
                categories: {},
                exclude: [],
                dialog: 'Hello, and welcome to Club Madeira. Let’s get started by telling us about your community.'
            };

        } catch (error) {
            logger.error('Error checking clubscan status', { userId, error: error.message });
            return { status: 'error', error_message: error.message, categories: {}, exclude: [], dialog: 'Error loading categories.' };
        }
    }
}

module.exports = handleCategory;