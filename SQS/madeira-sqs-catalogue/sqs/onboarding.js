// ====================== sqs/onboarding.js ======================
// Handles full async onboarding for communities
// Last updated: 12 June 2026

const { logger, enqueueMessage, executeWithRetry, sql } = require('/opt/nodejs/helpers');
const helpers = require('./helpers');   // ← Changed to avoid circular dependency

async function handle(event) {
    const { userId, url, partnerId, sandbox, pool } = event;

    if (!userId || !url || !partnerId || !pool) {
        logger.error('ONBOARDING called with missing required fields');
        return;
    }

    logger.info('Processing ONBOARDING', { userId, url, partnerId });

    return helpers.withStatusHandling(event, async () => {

        const createRecord = async () => {
            await pool.request()
                .input('url', sql.NVarChar, url)
                .input('clubId', sql.VarChar, userId)
                .input('partnerId', sql.VarChar, partnerId)
                .input('status', sql.VarChar, 'queued')
                .query(`
                    MERGE INTO clubscan AS target
                    USING (SELECT @clubId AS ClubID, @url AS Url, @partnerId AS PartnerId) AS source
                    ON target.ClubID = source.ClubID
                    WHEN MATCHED THEN 
                        UPDATE SET 
                            Url = @url,
                            PartnerId = @partnerId,
                            Status = @status,
                            UpdatedAt = GETDATE()
                    WHEN NOT MATCHED THEN 
                        INSERT (Url, ClubID, PartnerId, Status, CreatedAt, UpdatedAt)
                        VALUES (@url, @clubId, @partnerId, @status, GETDATE(), GETDATE());
                `);
        };

        await executeWithRetry(createRecord, { maxRetries: 3, logger });

        logger.info('clubscan record created/updated', { userId, url, partnerId });

        if (sandbox) {
            logger.info('Sandbox mode - skipping CLUBSCAN_GENERATE_REVIEW', { url });
            return;
        }

        await enqueueMessage({
            type: 'CLUBSCAN_GENERATE_REVIEW',
            url
        });

        logger.info('✅ Enqueued CLUBSCAN_GENERATE_REVIEW from ONBOARDING', { url });

    }, {
        startStatus: 'onboarding',
        successStatus: 'onboarding_complete'
    });
}

module.exports = { handle };