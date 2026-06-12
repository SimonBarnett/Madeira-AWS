// ====================== routes/token/index.js ======================
// Token / Auth Routes Sub-Router
// Called by the main orchestrator
// Last updated: 02 June 2026

const { logger } = require('/opt/nodejs/helpers');

// Individual route handlers (all now use modern export style)
const claimsRoute = require('./claims');
const loginRoute = require('./login');
const resetPasswordRoute = require('./reset-password');
const verifyResetCodeRoute = require('./verify-reset-code');
const onboardingRoute = require('./onboarding');
const completeSignupRoute = require('./complete-signup');
const tosRoute = require('./tos');
const addRoleRoute = require('./addRole');
const generateOnboardingTokenRoute = require('./generateOnboardingToken');
const validateOnboardingTokenRoute = require('./validateOnboardingToken');
const delegateRoute = require('./delegate');
const acceptDelegationRoute = require('./acceptdelegation');
const deleteRoute = require('./delete');
const deleteConfirmRoute = require('./deleteconfirm');

module.exports = async (event) => {
    const path = event.path || '/';
    const method = (event.httpMethod || '').toUpperCase();
    const decoded = event.decoded;

    logger.debug('Token router received request', { path, method });

    try {
        // ====================== ROUTING ======================
        if (path === '/login/claims' && method === 'GET') {
            return await claimsRoute(event);

        } else if (path === '/login' && method === 'POST') {
            return await loginRoute(event);

        } else if (path === '/login/reset-password' && method === 'POST') {
            return await resetPasswordRoute(event);

        } else if (path === '/login/verify-reset-code' && method === 'POST') {
            return await verifyResetCodeRoute(event);

        } else if (path === '/login/onboarding' && method === 'GET') {
            return await onboardingRoute(event);

        } else if (path === '/login/complete-signup' && method === 'POST') {
            return await completeSignupRoute(event);

        } else if (path === '/login/tos' && method === 'GET') {
            return await tosRoute(event);

        } else if (path === '/login/add-role' && method === 'POST') {
            return await addRoleRoute(event);

        } else if (path === '/login/generate-onboarding-token' && method === 'POST') {
            return await generateOnboardingTokenRoute(event);

        } else if (path === '/login/validate-onboarding-token' && method === 'PUT') {
            return await validateOnboardingTokenRoute(event);

        } else if (path === '/login/delegate' && method === 'POST') {
            return await delegateRoute(event);

        } else if (path === '/login/acceptdelegation' && method === 'POST') {
            return await acceptDelegationRoute(event);

        } else if (path === '/login/delete' && method === 'POST') {
            return await deleteRoute(event);

        } else if (path === '/login/deleteconfirm' && method === 'POST') {
            return await deleteConfirmRoute(event);

        } else {
            logger.warn('Token route not found', { path, method });
            return {
                statusCode: 404,
                body: { status: 'error', error_message: 'Route not found' }
            };
        }

    } catch (error) {
        logger.error('Error in token router', { path, error: error.message });
        return {
            statusCode: 500,
            body: { status: 'error', error_message: error.message || 'Internal Server Error' }
        };
    }
};