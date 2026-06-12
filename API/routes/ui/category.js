// ====================== routes/ui/category.js ======================
// Category route handler - uses SQS (CATEGORY_UPDATE)

const { logger, getUserCategories, enqueueMessage, setUserProcessing } = require('/opt/nodejs/helpers');

async function handleCategory(userId, body, method, { pool, sandbox = false } = {}) {
    logger.info('Handling category request', { userId, body, method });

    if (!userId || !body || !method) {
        return {
            status: 'error',
            error_message: 'Invalid request parameters',
            categories: {},
            exclude: [],
            dialog: 'We encountered an error. Please try again later.'
        };
    }

    if (method === 'POST') {
        logger.info('Enqueuing CATEGORY_UPDATE to SQS', { userId });

        try {
            await setUserProcessing(userId, true);
            await enqueueMessage({ type: 'CATEGORY_UPDATE', userId, body });

            if (sandbox) logger.debug('[SANDBOX] CATEGORY_UPDATE enqueued', { userId });

            return { status: 'success' };
        } catch (error) {
            logger.error('Failed to enqueue CATEGORY_UPDATE', { userId, error: error.message });
            await setUserProcessing(userId, false).catch(() => {});
            return {
                status: 'error',
                error_message: 'Failed to process your request',
                categories: {},
                exclude: [],
                dialog: 'We encountered an error while processing your categories.'
            };
        }
    } 

    else if (method === 'GET') {
        const userData = await getUserCategories(userId);

        if (userData.isProcessing) {
            return {
                status: 'processing',
                categories: {},
                exclude: [],
                dialog: 'We are still processing your request. Please wait a moment.'
            };
        }

        if (userData.error) {
            return {
                status: 'error',
                error_message: userData.error,
                categories: {},
                exclude: [],
                dialog: 'We encountered an error. Please try again later.'
            };
        }

        if (userData.categories && Object.keys(userData.categories).length > 0) {
            return {
                status: 'success',
                categories: userData.categories,
                exclude: userData.exclude || [],
                dialog: userData.chat?.[userData.chat.length - 1]?.dialog || 'Welcome back! Here are your current categories.'
            };
        }

        return {
            status: 'success',
            categories: {},
            exclude: [],
            dialog: 'Hello, and welcome to Club Madeira. Let’s get started by telling us about your community.'
        };
    }
}

module.exports = handleCategory;