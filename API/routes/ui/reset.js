// ====================== routes/ui/reset.js ======================
const { logger, getDbConnection, sql } = require('/opt/nodejs/helpers');

// Route handler for /category/reset
async function handleReset(userId) {
    let pool;
    try {
        pool = await getDbConnection();
        await pool.request()
            .input('uid', sql.VarChar, userId)
            .query(`
                DELETE FROM UserCategories WHERE uid = @uid;
            `);
        logger.info('Reset user categories', { userId });
        return {
            status: 'success',
            error_message: null,
            categories: {},
            exclude: [],
            dialog: 'Categories reset successfully. Let’s start fresh!'
        };
    } catch (error) {
        logger.error('Failed to reset categories', { userId, error: error.message, stack: error.stack });
        return {
            status: 'error',
            error_message: 'Failed to reset categories',
            categories: {},
            exclude: [],
            dialog: ''
        };
    } finally {
        if (pool) {
            await pool.close();
            logger.debug('Database connection closed');
        }
    }
}

module.exports = handleReset;