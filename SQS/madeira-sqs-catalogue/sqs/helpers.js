const { sql, getDbConnection, executeWithRetry, logger } = require('/opt/nodejs/helpers');

async function updateStatus(pool, url, status) {
    const queryFn = async () => {
        await pool.request()
            .input('url', sql.NVarChar, url)
            .input('status', sql.VarChar, status)
            .query(`
                UPDATE clubscan 
                SET Status = @status, UpdatedAt = GETDATE() 
                WHERE Url = @url
            `);
    };

    try {
        await executeWithRetry(queryFn, { maxRetries: 3, logger });
    } catch (err) {
        logger.warn('Failed to update status after retries', {
            url,
            status,
            error: err.message
        });
    }
}

async function setLastError(pool, url, error) {
    const errorMessage = error?.message || String(error || 'Unknown error');

    const queryFn = async () => {
        await pool.request()
            .input('url', sql.NVarChar, url)
            .input('lastError', sql.NVarChar(sql.MAX), errorMessage)
            .query(`
                UPDATE clubscan 
                SET LastError = @lastError, UpdatedAt = GETDATE() 
                WHERE Url = @url
            `);
    };

    try {
        await executeWithRetry(queryFn, { maxRetries: 3, logger });
    } catch (err) {
        logger.warn('Failed to set LastError after retries', {
            url,
            error: err.message
        });
    }
}

async function sendFailureEmailOnError(url, errorMessage) {
    try {
        const failureRecipient = process.env.SANDBOX_NOTIFY;
        if (!failureRecipient) {
            logger.warn('SANDBOX_NOTIFY env var is not set — skipping failure email', { url });
            return;
        }
        const { sendFailureEmail } = require('../emails');
        await sendFailureEmail([failureRecipient], url, errorMessage);
    } catch (err) {
        logger.error('Failed to send failure email', { url, error: err.message });
    }
}

async function withStatusHandling(event, fn, options = {}) {
    const { url, sandbox, pool } = event;

    if (!url) {
        logger.error('Handler called without url');
        return;
    }

    if (!pool) {
        logger.error('withStatusHandling called without an open pool');
        throw new Error('No pool provided to withStatusHandling');
    }

    try {
        if (options.startStatus) {
            await updateStatus(pool, url, options.startStatus);
        }

        const result = await fn({ pool, url, event, sandbox });

        if (options.successStatus) {
            await updateStatus(pool, url, options.successStatus);
        }

        return result;

    } catch (error) {
        logger.error('Error in handler', { url, error: error.message });

        const errorMessage = error?.message || 'Unknown error';

        try {
            await updateStatus(pool, url, 'failed');
            await setLastError(pool, url, errorMessage);
        } catch (_) {}

        await sendFailureEmailOnError(url, errorMessage);
        throw error;

    } finally {
        // Never close pool here
    }
}

module.exports = {
    updateStatus,
    setLastError,
    withStatusHandling
};