// madeira-affiliate/index.js
// Main Router / SQS Coordinator
// Updated: 10 June 2026

const { getDbPool, closeDbPool } = require('/opt/nodejs/conf/db-config');
const { logger } = require('/opt/nodejs/helpers');

// ====================== IMPORT ROUTE HANDLERS ======================
const scheduler   = require('./sqs/scheduler');
const affiliate   = require('./sqs/affiliate');

const grokBatch   = require('./sqs/grokBatch');
const grokPoll    = require('./sqs/grokPoll');

// ====================== MAINTENANCE WINDOW CHECK ======================
async function isMaintenanceWindowActive(pool) {
    const result = await pool.request().query(`
        SELECT COUNT(*) AS ActiveCount
        FROM dbo.LASTS
        WHERE OperationName = 'MAINTAINANCE_WINDOW'
    `);

    const isActive = result.recordset[0].ActiveCount > 0;

    if (isActive) {
        logger.warn('⏳ Maintenance window is ACTIVE — processing is DISABLED');
    }

    return isActive;
}

// ====================== INDEX REBUILD STATUS CHECK ======================
async function checkIndexRebuildStatus(pool) {    
    
    const thresholdMinutes = parseInt(process.env.INDEX_REBUILD_THRESHOLD_MINUTES || '30', 10);    
    const result = await pool.request()
        .input('operationName', 'IndexesBulkLoadDisabled')
        .query(`
            SELECT TOP 1 LastRun
            FROM LASTS
            WHERE OperationName = @operationName
        `);

    if (result.recordset.length === 0) {        
        return { shouldExit: false, shouldRestart: false };
    }

    const lastRun = result.recordset[0].LastRun;
    const minutesSinceLastRun = (Date.now() - new Date(lastRun).getTime()) / (1000 * 60);

    logger.info('📊 Index rebuild status', {
        lastRun,             
        minutesSinceLastRun: Math.round(minutesSinceLastRun),
        thresholdMinutes
    });

    if (minutesSinceLastRun < thresholdMinutes) {
        logger.warn('⏳ Indexes are being rebuilt (LastRun is recent). Skipping processing.');
        return { shouldExit: true, shouldRestart: false, minutesSinceLastRun };
    }

    // Older than threshold → needs restart
    logger.warn('♻️ Indexes rebuild record is stale. Will trigger restart.');
    return { shouldExit: false, shouldRestart: true, minutesSinceLastRun };
}

// ====================== RESTART INDEX REBUILD ======================
async function triggerIndexRebuildRestart(pool, isSandbox) {

    // Always update LastRun first
    await pool.request()
        .input('operationName', 'IndexesBulkLoadDisabled')
        .query(`
            UPDATE LASTS
            SET LastRun = GETDATE()
            WHERE OperationName = @operationName
        `);

    if (isSandbox) {
        // Sandbox mode: delete record to simulate restart
        await pool.request()
            .input('operationName', 'IndexesBulkLoadDisabled')
            .query(`
                DELETE FROM LASTS
                WHERE OperationName = @operationName
            `);

        logger.warn('🧪 [SANDBOX] Deleted IndexesBulkLoadDisabled record to simulate rebuild restart');
    } else {
        // Production: Fire KillAndRestartRebuild in a safer fire-and-forget way
        setImmediate(() => {
            pool.request()
                .query(`EXEC KillAndRestartRebuild`)
                .catch(err => {
                    logger.error('Failed to execute KillAndRestartRebuild', { 
                        error: err.message 
                    });
                });
        });

        logger.warn('🚀 Triggered KillAndRestartRebuild procedure');
    }
}

exports.handler = async (event) => {
    const isSandbox = event?.sandbox === true;
    const startTime = Date.now();

    if (isSandbox) {
        logger.info('🧪 SANDBOX MODE ENABLED');
    }

    let pool = null;

    try {
        pool = await getDbPool();

        // ====================== MAINTENANCE WINDOW CHECK ======================
        const inMaintenance = await isMaintenanceWindowActive(pool);
        if (inMaintenance) {
            logger.warn('🛑 Maintenance window active — exiting immediately (no processing will occur)');
            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: "Skipped due to active maintenance window",
                    maintenanceWindow: true,
                    processed: 0
                })
            };
        }

        // ====================== INDEX REBUILD STATUS CHECK ======================
        const indexStatus = await checkIndexRebuildStatus(pool);
        if (indexStatus.shouldExit) {
            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: "Skipped - indexes are being rebuilt",
                    skipped: true,
                    reason: "IndexesBulkLoadDisabled is recent",
                    minutesSinceLastRun: Math.round(indexStatus.minutesSinceLastRun)
                })
            };
        }

        if (indexStatus.shouldRestart) {
            await triggerIndexRebuildRestart(pool, isSandbox);
            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: "Triggered index rebuild restart",
                    skipped: true,
                    reason: "IndexesBulkLoadDisabled was stale"
                })
            };
        }

        // ====================== EVENTBRIDGE / SCHEDULED MODE ======================
        if (!event.Records) {
            logger.info('🚀 EventBridge/Scheduled invocation detected');

            const task = event.task || event["detail-type"] || "scheduler";

            logger.info(`📌 Task received: ${task}`, { 
                sandbox: isSandbox,
                hasRecords: false 
            });

            // =====================================================
            // TASK ROUTING (EventBridge)
            // =====================================================

            // Main scheduled route → Scheduler only
            if (task === "scheduler" || task === "main-scheduler") {
                logger.info(isSandbox 
                    ? '🧪 [SANDBOX] Running Scheduler only' 
                    : '🚀 Running Scheduler only');
                return await scheduler.run(pool, event);
            }

            // Separate route for GROK_POLL
            if (task === "grok-poll" || task === "GROK_POLL") {
                logger.info(isSandbox 
                    ? '🧪 [SANDBOX] Running GROK_POLL only' 
                    : '🚀 Running GROK_POLL only');
                return await grokPoll.run(event, pool);
            }

        }

        // ====================== SQS WORKER MODE ======================
        if (event.Records && event.Records.length > 0) {
            logger.info(`📦 SQS batch received`, { 
                messageCount: event.Records.length,
                sandbox: isSandbox 
            });

            const results = await Promise.allSettled(
                event.Records.map(async (record, idx) => {
                    let msg;
                    try {
                        msg = JSON.parse(record.body);
                    } catch (parseErr) {
                        logger.error('❌ Failed to parse SQS message body', { index: idx });
                        throw new Error(`Invalid JSON in record ${idx}`);
                    }

                    logger.debug('Processing SQS message', {
                        index: idx,
                        type: msg.type,
                        catalogId: msg.catalogId
                    });

                    switch (msg.type) {
                        case "PROCESS_CATEGORY":
                            return await affiliate.run(msg, pool);

                        case "GROK_BATCH":
                            return await grokBatch.run(msg, pool);

                        case "GROK_POLL":
                            return await grokPoll.run(msg, pool);

                        default:
                            logger.warn('⚠️ Unknown SQS message type', { type: msg.type });
                            return { statusCode: 400, body: `Unknown type: ${msg.type}` };
                    }
                })
            );

            const failures = results.filter(r => r.status === 'rejected');
            const successCount = results.length - failures.length;
            const duration = Date.now() - startTime;

            if (failures.length > 0) {
                logger.warn(`⚠️ SQS batch completed with failures`, {
                    total: results.length,
                    succeeded: successCount,
                    failed: failures.length,
                    durationMs: duration
                });
            } else {
                logger.info(`✅ SQS batch processed successfully`, {
                    total: results.length,
                    durationMs: duration
                });
            }

            return {
                statusCode: failures.length > 0 ? 207 : 200,
                body: JSON.stringify({
                    processed: results.length,
                    succeeded: successCount,
                    failed: failures.length,
                    durationMs: duration
                })
            };
        }

        logger.warn('⚠️ Invalid event received (no Records and no task)');
        return { statusCode: 400, body: 'Invalid event format' };

    } catch (err) {
        logger.error('💥 Coordinator failed', { 
            error: err.message,
            stack: err.stack 
        });
        throw err;
    } finally {
        if (pool) {
            try {
                await closeDbPool();
                logger.debug('Database pool closed');
            } catch (closeErr) {
                logger.warn('Failed to close database pool', { error: closeErr.message });
            }
        }
    }
};