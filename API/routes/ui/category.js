// ====================== routes/ui/category.js ======================
// Category route handler
// Now uses clubscan.Status instead of isProcessing flag
// 'finish on complete' - shows categories only when ClubScan status reaches a terminal state

const { logger, executeWithRetry, sql, enqueueMessage, setUserProcessing } = require('/opt/nodejs/helpers');

async function handleCategory(userId, body, method, { pool, sandbox = false } = {}) {
    logger.info('Handling category request', { userId, method });

    if (!userId) {
        return { status: 'error', error_message: 'Invalid user', categories: {}, exclude: [], dialog: 'Error' };
    }

    if (method === 'POST') {
        try {
            await setUserProcessing(userId, true);

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
            await setUserProcessing(userId, false).catch(() => {});
            return { status: 'error', error_message: 'Failed to process request', categories: {}, exclude: [], dialog: 'Error processing categories.' };
        }
    }

    // GET - Check clubscan status instead of isProcessing flag
    if (method === 'GET') {
        try {
            const clubscanResult = await executeWithRetry(() =>
                pool.request()
                    .input('clubId', sql.VarChar, userId)
                    .query(`
                        SELECT TOP 1 Status, UpdatedAt 
                        FROM clubscan 
                        WHERE ClubID = @clubId 
                        ORDER BY UpdatedAt DESC
                    `)
            );

            const clubscan = clubscanResult.recordset[0];
            const status = clubscan?.Status || 'not_started';

            const isProcessing = ['queued', 'generating_categories', 'building_catalog', 'fetching_content'].includes(status);

            if (isProcessing) {
                return {
                    status: 'processing',
                    categories: {},
                    exclude: [],
                    dialog: 'We are still processing your community data. Please wait a moment.'
                };
            }

            // If complete or categories_complete, fetch from UserCategories
            if (['complete', 'categories_complete', 'catalog_complete'].includes(status)) {
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

            // Default / not started
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