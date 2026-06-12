// ====================== routes/token/login.js ======================
// Login handler for token-based authentication
// Uses comparePassword + logger from core layer, other helpers from ./helpers
// Last updated: 03 June 2026

const { logger, comparePassword } = require('/opt/nodejs/helpers');
const { signJWT } = require('/opt/nodejs/jwt');

// Local helpers (specific to token routes)
const {
    verifyAffiliate,
    getUserByEmail,
    getLastLogin,
    setLastLogin
} = require('./helpers');

module.exports = async (event) => {
    const requestId = event.requestContext?.requestId || 'unknown';
    const ipAddress = event.requestContext?.identity?.sourceIp;
    const startTotal = Date.now();

    let body;
    try {
        body = event.body ? JSON.parse(event.body) : {};
    } catch (parseError) {
        logger.warn('Invalid JSON body', { requestId });
        return {
            statusCode: 400,
            body: { status: 'error', error_message: 'Invalid request body' }
        };
    }

    const { email, password, signup_url, affiliate } = body;

    // Input validation with clear messages
    if (!email) {
        logger.warn('Missing email', { requestId });
        return { statusCode: 400, body: { status: 'error', error_message: 'Email is required' } };
    }
    if (!password) {
        logger.warn('Missing password', { requestId });
        return { statusCode: 400, body: { status: 'error', error_message: 'Password is required' } };
    }
    if (!signup_url) {
        logger.warn('Missing signup_url', { requestId });
        return { statusCode: 400, body: { status: 'error', error_message: 'Signup URL is required' } };
    }
    if (!affiliate) {
        logger.warn('Missing affiliate code', { requestId });
        return { statusCode: 400, body: { status: 'error', error_message: 'Affiliate code is required' } };
    }

    // Validate signup_url format
    let signupUrl;
    try {
        signupUrl = new URL(signup_url).href;
    } catch (err) {
        logger.warn('Invalid signup_url format', { requestId });
        return { statusCode: 400, body: { status: 'error', error_message: 'Invalid signup_url' } };
    }

    // Verify affiliate
    const affiliateVerification = await verifyAffiliate(affiliate);
    if (!affiliateVerification.valid) {
        logger.warn('Affiliate verification failed', { requestId, reason: affiliateVerification.reason });
        return { statusCode: 400, body: { status: 'error', error_message: affiliateVerification.reason } };
    }

    // Get user (pass event for owner permission logic if needed in getUserByEmail)
    const user = await getUserByEmail(email, event);
    if (!user) {
        logger.warn('User not found', { requestId, email });
        return { statusCode: 401, body: { status: 'error', error_message: 'Invalid credentials' } };
    }

    // Password comparison using comparePassword from layer
    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
        logger.warn('Invalid password', { requestId, userId: user.user_id });
        return { statusCode: 401, body: { status: 'error', error_message: 'Invalid credentials' } };
    }

    // Generate JWT
    const payload = {
        user_id: user.user_id,
        permissions: user.permissions,
        exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60)
    };

    let token;
    try {
        token = await signJWT(payload);
        if (typeof token !== 'string' || token.length < 50 || !token.startsWith('eyJ')) {
            throw new Error('signJWT returned invalid token');
        }
    } catch (err) {
        logger.error('Failed to generate JWT', { requestId, userId: user.user_id, error: err.message });
        return { statusCode: 500, body: { status: 'error', error_message: 'Failed to generate authentication token' } };
    }

    const contactName = user.company_name || user.first_name || 'User';

    // Last login message
    const lastLogin = await getLastLogin(user.user_id);
    let lastLoginMessage;
    if (lastLogin) {
        const loginTime = new Date(lastLogin.timestamp);
        const formattedTime = loginTime.toLocaleString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric'
        });
        lastLoginMessage = `You last logged in at ${formattedTime} from ${lastLogin.IP}.`;
    }

    // Update last login
    await setLastLogin(user.user_id, ipAddress);

    // Build response
    const responseBody = {
        status: 'success',
        token,
        user_id: user.user_id,
        contact_name: contactName,
        workflow: 'login'
    };

    if (lastLoginMessage) {
        responseBody.lastlogin = lastLoginMessage;
    }

    logger.info('Login successful', {
        requestId,
        userId: user.user_id,
        durationMs: Date.now() - startTotal
    });

    return {
        statusCode: 200,
        body: responseBody
    };
};
