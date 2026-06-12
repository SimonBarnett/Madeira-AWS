// index.js - madeira-awin-clubscan (CLEAN ORCHESTRATOR)

const { getDbConnection, logger } = require('./helpers');

const syncMerchantsRoute = require('./routes/sync-merchants');
const clubRoute          = require('./routes/club');
const globalRoute        = require('./routes/global');
const onboardingRoute    = require('./routes/onboarding');
const awinPaymentsRoute  = require('./routes/awin-payments');

exports.handler = async (event) => {
    logger.info('🚀 madeira-awin-clubscan orchestrator started', {
        route: event.route,
        hasClubId: !!event.clubId,
        isOnboarding: event.onboarding === true || event.route === 'onboarding',
        isSyncOnly: event.route === 'sync-merchants',
        isPaymentsOnly: event.route === 'awin-payments'
    });

    let pool = null;

    try {
        pool = await getDbConnection();

        // ====================== INDEPENDENT ROUTES ======================
        if (event.route === 'sync-merchants') {
            logger.info('🔄 Independent sync-merchants route triggered');
            return await syncMerchantsRoute.run(pool);
        }

        if (event.route === 'awin-payments') {
            logger.info('💰 Independent awin-payments route triggered');
            return await awinPaymentsRoute.run(pool);
        }

        // ====================== ONBOARDING (runs BOTH background jobs first) ======================
        if (event.onboarding === true || event.route === 'onboarding') {
            logger.info('🔄 Onboarding detected → running sync + payments first');

            await syncMerchantsRoute.run(pool);     // always run sync
            await awinPaymentsRoute.run(pool);      // always run payments

            logger.info('✅ Background jobs completed before onboarding');
            
            logger.info('🎯 Starting onboarding route');
            return await onboardingRoute.handler(event);
        }

        // ====================== OTHER ROUTES ======================
        if (event.clubId) {
            logger.info('🎯 Club route triggered', { clubId: event.clubId });
            return await clubRoute.handler(event);
        }

        // Default fallback
        logger.info('🎯 Global route triggered (default)');
        return await globalRoute.handler(event);

    } catch (error) {
        logger.error('💥 Orchestrator failed', { error: error.message, stack: error.stack });
        return { statusCode: 500, body: error.message };
    } finally {
        if (pool) await pool.close().catch(() => {});
    }
};