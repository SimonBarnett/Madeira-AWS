// ====================== madeira-sqs-catalogue/index.js ======================
// Thin SQS Orchestrator
// Gets DB pool once using getDbPool() from conf/db-config
// Passes the open pool to every handler
// Handlers and helpers must NOT close the pool
// Last updated: 12 June 2026

const { logger } = require('/opt/nodejs/helpers');
const { getDbPool } = require('/opt/nodejs/conf/db-config');

exports.handler = async (event) => {
    logger.info('SQS Orchestrator started', {
        recordCount: event.Records?.length || 0
    });

    const batchItemFailures = [];
    let pool = null;

    try {
        // Get the pool once for the whole invocation
        pool = await getDbPool();

        for (const record of event.Records || []) {
            let payload;

            try {
                payload = JSON.parse(record.body);
                const messageType = (payload.type || 'UNKNOWN').toUpperCase();

                // Enrich payload with sandbox flag + shared pool
                const enrichedPayload = {
                    ...payload,
                    sandbox: payload.sandbox === true,
                    pool                    // ← Pass the open pool
                };

                logger.debug('Routing SQS message', {
                    messageId: record.messageId,
                    type: messageType,
                    sandbox: enrichedPayload.sandbox
                });

                switch (messageType) {

                    // === ONBOARDING FLOW (Communities) ===
                    case 'ONBOARDING':
                        await require('./sqs/onboarding').handle(enrichedPayload);
                        break;

                    // === CATEGORY FLOW ===
                    case 'CATEGORY_UPDATE':
                        await require('./sqs/process-update').handle(enrichedPayload);
                        break;

                    // === CLUBSCAN PIPELINE ===
                    case 'CLUBSCAN_GENERATE_REVIEW':
                        await require('./sqs/generate-review').handle(enrichedPayload);
                        break;

                    case 'CLUBSCAN_GENERATE_CATEGORIES':
                        await require('./sqs/generate-categories').handle(enrichedPayload);
                        break;

                    case 'CLUBSCAN_BUILD_CATALOG':
                        await require('./sqs/build-catalog').handle(enrichedPayload);
                        break;

                    case 'CLUBSCAN_NOTIFY':
                        await require('./sqs/notify').handle(enrichedPayload);
                        break;

                    default:
                        logger.warn('Unknown message type — skipping', {
                            messageId: record.messageId,
                            type: messageType
                        });
                        break;
                }

            } catch (error) {
                logger.error('Failed to process SQS record', {
                    messageId: record.messageId,
                    type: payload?.type,
                    error: error.message,
                    stack: error.stack
                });

                batchItemFailures.push({
                    itemIdentifier: record.messageId
                });
            }
        }

    } catch (err) {
        logger.error('SQS Orchestrator failed', {
            error: err.message,
            stack: err.stack
        });
        throw err;

    } finally {
        // Intentionally not closing the pool here for stability
    }

    return { batchItemFailures };
};