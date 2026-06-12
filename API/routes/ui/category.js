// ====================== routes/ui/category.js ======================
// Category route handler
// Uses clubscan.Status as the single source of truth for processing state.
// Old isProcessing flag / setUserProcessing calls have been removed.
// Terminal state is now driven by ClubScan jobs (clubscan.Status = 'completed' or equivalent).

const { logger, executeWithRetry, sql, enqueueMessage } = require('/opt/nodejs/helpers');

async function handleCategory(userId, body, method, { pool, sandbox = false } = {}) {
    logger.info('Handling category request', { userId, method });

    if (!userId) {
        return { status: 'error', error_message: 'Invalid user', categories: {}, exclude: [], dialog: 'Error' };
    }

    if (method === 'POST') {
        try {
            // Note: We no longer call setUserProcessing here.
            // ClubScan pipeline now owns the processing state via clubscan.Status
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
                        SELECT TOP 1 Status, UpdatedAt 
                        FROM clubscan 
                        WHERE ClubID = @clubId 
                        ORDER BY UpdatedAt DESC
                    `)
            );

            const clubscan = clubscanResult.recordset[0];
            const status = (clubscan?.Status || 'not_started').toLowerCase();

            const isProcessing = ['queued', 'generating_categories', 'building_catalog', 'fetching_content', 'processing'].includes(status);

            if (isProcessing) {
                return {
                    status: 'processing',
                    categories: {},
                    exclude: [],
                    dialog: 'We are still processing your community data. Please wait a moment.'
                };
            }

            // Finished when status reaches completed / complete / categories_complete etc.
            if (['completed', 'complete', 'categories_complete', 'catalog_complete'].includes(status)) {
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

            // Not started yet
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