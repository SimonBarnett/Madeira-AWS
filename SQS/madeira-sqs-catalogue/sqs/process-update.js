const {
    logger,
    enqueueMessage,
    executeWithRetry,
    sql
} = require('/opt/nodejs/helpers');

const { callGrokStructured } = require('/opt/nodejs/grok');
const { CATEGORY_SCHEMA } = require('../grok_schema');
const { withStatusHandling, updateStatus } = require('./helpers');

// ====================== BUSINESS LOGIC HELPERS ======================
async function getUserCategories(pool, userId) {
    const queryFn = async () => {
        const result = await pool.request()
            .input('uid', sql.VarChar, userId)
            .query('SELECT json_categories, json_exclude, json_chat FROM UserCategories WHERE uid = @uid');

        if (result.recordset.length > 0) {
            const row = result.recordset[0];
            return {
                categories: JSON.parse(row.json_categories || '{}'),
                exclude: JSON.parse(row.json_exclude || '[]'),
                chat: JSON.parse(row.json_chat || '[]')
            };
        }
        return { categories: {}, exclude: [], chat: [] };
    };

    return executeWithRetry(queryFn, { maxRetries: 3, logger });
}

async function saveUserCategories(pool, userId, categoriesData) {
    const queryFn = async () => {
        await pool.request()
            .input('uid', sql.VarChar, userId)
            .input('json_categories', sql.NVarChar, JSON.stringify(categoriesData.categories || {}))
            .input('json_exclude', sql.NVarChar, JSON.stringify(categoriesData.exclude || []))
            .input('json_chat', sql.NVarChar, JSON.stringify(categoriesData.chat || []))
            .query(`
                MERGE INTO UserCategories AS target
                USING (SELECT @uid AS uid) AS source
                ON (target.uid = source.uid)
                WHEN MATCHED THEN
                    UPDATE SET json_categories = @json_categories, json_exclude = @json_exclude, json_chat = @json_chat
                WHEN NOT MATCHED THEN
                    INSERT (uid, json_categories, json_exclude, json_chat)
                    VALUES (@uid, @json_categories, @json_exclude, @json_chat);
            `);
    };

    return executeWithRetry(queryFn, { maxRetries: 3, logger });
}

// ====================== MAIN HANDLER ======================
async function handle(payload) {
    const { userId, body, pool } = payload;   // ← pool comes from the orchestrator

    if (!userId) {
        logger.error('process-update called without userId');
        return;
    }

    if (!pool) {
        logger.error('process-update called without shared pool');
        return;
    }

    logger.info('Processing CATEGORY_UPDATE', { userId });

    try {
        const url = await getUrlForUserId(pool, userId);
        if (!url) {
            logger.error('No url found for userId in clubscan table', { userId });
            return;
        }

        const enrichedPayload = {
            ...payload,
            url,
            pool
        };

        return withStatusHandling(enrichedPayload, async ({ pool: passedPool }) => {

            const userData = await getUserCategories(passedPool, userId);
            const currentCategories = userData.categories || {};
            let chat = userData.chat || [];
            const currentExclusions = userData.exclude || [];

            const prompt = body.prompt?.trim() || '';
            const newExclusions = Array.isArray(body.exclude) ? body.exclude : [];
            const updatedExclusions = [...new Set([...currentExclusions, ...newExclusions].map(e => e.toLowerCase()))];

            if (!prompt && Object.keys(currentCategories).length > 0) {
                await updateStatus(passedPool, url, 'complete');
                return;
            }

            chat.push({ prompt });

            const messages = [
                { role: 'system', content: 'You are an expert in e-commerce affiliate marketing.' },
                { role: 'user', content: `Current categories: ${JSON.stringify(currentCategories)}\n\nPrompt: '${prompt}'` }
            ];

            const result = await callGrokStructured(messages, CATEGORY_SCHEMA, {
                temperature: 0.3,
                max_tokens: 8000
            });

            let categories = currentCategories;
            if (result?.categories) categories = result.categories;

            await saveUserCategories(passedPool, userId, {
                categories,
                exclude: updatedExclusions,
                chat
            });

            logger.info('Categories updated via structured Grok', { userId });

            await enqueueMessage({
                type: 'CLUBSCAN_BUILD_CATALOG',
                url,
                userId,
                enqueueNotify: false
            });

            logger.info('✅ Categories updated and CLUBSCAN_BUILD_CATALOG enqueued', { userId, url });

        }, {
            startStatus: 'updating_catalog',
            successStatus: 'updating_complete'
        });

    } catch (error) {
        logger.error('Error in process-update', { userId, error: error.message });
        if (pool && url) {
            await updateStatus(pool, url, 'failed').catch(() => {});
        }
        throw error;
    }
    // No finally block — pool is managed at the orchestrator level
}

async function getUrlForUserId(pool, userId) {
    const result = await pool.request()
        .input('uid', sql.VarChar, userId)
        .query('SELECT Url FROM clubscan WHERE ClubID = @uid');
    return result.recordset[0]?.Url || null;
}

module.exports = { handle };