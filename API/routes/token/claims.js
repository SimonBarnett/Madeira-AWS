// ====================== routes/token/claims.js ======================
const { logger } = require('/opt/nodejs/helpers');
const { originCode } = require('./helpers');

module.exports = async (event) => {
    const decoded = event.decoded;
    let roles = decoded.permissions || [];

    logger.info('Token verified', { userId: decoded.user_id, roles });

    // Add 'owner' role if user is partner and matches originCode
    if (roles.includes('partner')) {
        try {
            const code = await originCode(event);
            if (decoded.user_id === code) {
                roles.push('owner');
                logger.info('Added "owner" role based on originCode match', { userId: decoded.user_id });
            }
        } catch (error) {
            logger.warn('Failed to fetch or match originCode', { error: error.message });
        }
    }

    return {
        statusCode: 200,
        body: { roles }
    };
};