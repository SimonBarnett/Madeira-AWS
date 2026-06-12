// ====================== routes/amazoncard/index.js ======================
// Amazon Card routes (Claim + Topup)
// Supports both API Gateway and EventBridge invocations
// Last updated: 02 June 2026

const { logger } = require('/opt/nodejs/helpers');

const claimHandler = require('./claim');
const topupHandler = require('./topup');

module.exports = async (event) => {
    logger.debug('AmazonCard router invoked', {
        hasRequestContext: !!event.requestContext,
        source: event.source,
        detailType: event['detail-type']
    });

    try {
        // API Gateway → Claim
        if (event.requestContext) {
            logger.info('Processing Claim request (API Gateway)');
            return await claimHandler(event);
        }

        // EventBridge → Topup
        if (
            event.source === 'madeira.amazoncards' ||
            event['detail-type'] === 'AmazonCards.Topup' ||
            (event.detail && event.detail.action === 'topup')
        ) {
            logger.info('Processing Topup request (EventBridge)');
            return await topupHandler(event);
        }

        return {
            statusCode: 400,
            body: { success: false, reason: 'Invalid invocation type' }
        };

    } catch (error) {
        logger.error('AmazonCard router error', { error: error.message });
        return {
            statusCode: 500,
            body: { success: false, reason: 'Internal server error' }
        };
    }
};