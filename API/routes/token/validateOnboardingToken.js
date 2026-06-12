// ====================== routes/token/validateOnboardingToken.js ======================
// Validates onboarding PIN and returns Stripe account link
// Uses core layer + local helpers
// Last updated: 03 June 2026

const { logger, getDbConnection, sql, getStripeClient } = require('/opt/nodejs/helpers');
const { verifyJWT } = require('/opt/nodejs/jwt');

// Local helpers
const { getUserById } = require('./helpers');

module.exports = async (event) => {
    const requestId = event.requestContext?.requestId || 'unknown';
    const body = event.body ? JSON.parse(event.body) : {};
    const { token: onboardingToken, pin } = body;

    if (!onboardingToken || !pin) {
        logger.warn('Missing token or PIN', { requestId });
        return { statusCode: 400, body: { status: 'error', error_message: 'Token and PIN are required' } };
    }

    // Verify onboarding token
    let payload;
    try {
        payload = await verifyJWT(onboardingToken);
        logger.debug('Onboarding token verified', { requestId, referrerId: payload.referrerId });
    } catch (error) {
        logger.warn('Invalid or malformed onboarding token', { requestId, error: error.message });
        return { statusCode: 401, body: { status: 'error', error_message: 'Invalid or malformed token' } };
    }

    // Check token expiry
    if (new Date() > new Date(payload.expiry)) {
        logger.warn('Token has expired', { requestId, expiry: payload.expiry });
        return { statusCode: 401, body: { status: 'error', error_message: 'Token has expired' } };
    }

    // Validate referrer
    const referrer = await getUserById(payload.referrerId, event);
    if (!referrer || (!referrer.permissions.includes('admin') && !referrer.permissions.includes('partner'))) {
        logger.warn('Invalid or unauthorized referrer', { requestId, referrerId: payload.referrerId });
        return { statusCode: 403, body: { status: 'error', error_message: 'Invalid or unauthorized referrer' } };
    }

    // Retrieve token metadata from DB
    const pool = await getDbConnection();
    let tokenData;
    try {
        const result = await pool.request()
            .input('token_id', sql.VarChar(512), onboardingToken)
            .query('SELECT pin, validated, signup_url, stripe_account_id FROM Tokens WHERE token_id = @token_id');

        if (result.recordset.length === 0) {
            logger.warn('Token not found', { requestId });
            return { statusCode: 404, body: { status: 'error', error_message: 'Token not found' } };
        }
        tokenData = result.recordset[0];
    } finally {
        await pool.close();
    }

    // Validate PIN
    if (tokenData.pin !== pin) {
        logger.warn('Invalid PIN', { requestId });
        return { statusCode: 401, body: { status: 'error', error_message: 'Invalid PIN' } };
    }

    // Initialize Stripe client
    let stripe;
    try {
        stripe = await getStripeClient(event);
    } catch (error) {
        logger.error('Failed to get Stripe client', { requestId, error: error.message });
        return { statusCode: 500, body: { status: 'error', error_message: 'Failed to initialize Stripe' } };
    }

    // Build return and refresh URLs
    const return_url = `https://ytepcnwske.execute-api.eu-west-2.amazonaws.com/prod/login/onboarding?token=${onboardingToken}`;

    const refreshUrl = new URL(tokenData.signup_url);
    refreshUrl.searchParams.append('signup', 'fail');
    const refresh_url = refreshUrl.toString();

    // Create Stripe Account Link
    let account_link;
    try {
        account_link = await stripe.accountLinks.create({
            account: tokenData.stripe_account_id,
            refresh_url: refresh_url,
            return_url: return_url,
            type: 'account_onboarding'
        });
        logger.info('Stripe account link created', { requestId, accountId: tokenData.stripe_account_id });
    } catch (error) {
        logger.error('Failed to create Stripe account link', { requestId, error: error.message });
        return { statusCode: 500, body: { status: 'error', error_message: 'Failed to create Stripe account link' } };
    }

    // Success response
    return {
        statusCode: 200,
        body: {
            status: 'success',
            account_link: account_link.url
        }
    };
};
