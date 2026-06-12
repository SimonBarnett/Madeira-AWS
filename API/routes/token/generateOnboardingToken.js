// ====================== routes/token/generateOnboardingToken.js ======================
// Generates onboarding tokens for new users (community / merchant / partner)
// Last updated: 02 June 2026

const { logger, getDbConnection, sql } = require('/opt/nodejs/helpers');
const { signJWT } = require('/opt/nodejs/jwt');
const { sendSmsTextmagic } = require('/opt/nodejs/sms');

// Local helpers (includes email sending via ./email.js)
const {
    generatePin,
    normalizePhone,
    isValidPhone,
    isValidEmail,
    getUserById,
    originCode,
    getTrafficAv
} = require('./helpers');

// Email templates + sending (mailer is handled inside ./email.js)
const { sendEmail } = require('./email');

module.exports = async (event) => {
    const body = event.body ? JSON.parse(event.body) : {};
    const decoded = event.decoded;

    const user = await getUserById(decoded.user_id, event);
    if (!user) {
        return { statusCode: 404, body: { status: 'error', error_message: 'User not found' } };
    }

    // Permission checks
    if (!user.permissions.includes('admin') && !user.permissions.includes('partner')) {
        return {
            statusCode: 403,
            body: { status: 'error', error_message: 'Forbidden: Requires admin or partner permission' }
        };
    }

    const { mobile, email, tokenType, url, communityId } = body;

    if (!mobile || !email || !tokenType) {
        return { statusCode: 400, body: { status: 'error', error_message: 'Phone, email and tokenType are required' } };
    }

    const normalizedPhone = normalizePhone(mobile);
    if (!isValidPhone(normalizedPhone) || !isValidEmail(email)) {
        return { statusCode: 400, body: { status: 'error', error_message: 'Invalid phone or email format' } };
    }

    // Extra permission + traffic checks for non-admins
    if (!user.permissions.includes('admin')) {
        if (!user.permissions.includes('owner') && !user.permissions.includes('partner')) {
            return { statusCode: 403, body: { status: 'error', error_message: 'Insufficient permission' } };
        }

        if (!user.permissions.includes('owner') && tokenType !== 'merchant') {
            return { statusCode: 403, body: { status: 'error', error_message: 'Only site owners can invite communities or partners' } };
        }

        const targetUrl = url || communityId;
        if ((tokenType === 'community' || tokenType === 'partner') && !targetUrl) {
            return { statusCode: 400, body: { status: 'error', error_message: 'URL is required for this invitation type' } };
        }

        if (tokenType === 'partner') {
            const trafficCheck = await getTrafficAv(decoded.user_id);
            if (!trafficCheck.success) {
                return { statusCode: 403, body: { status: 'error', error_message: 'All available invites in use.' } };
            }
        }
    }

    const pool = await getDbConnection();

    // Check if email already exists
    const userCheck = await pool.request()
        .input('email', sql.VarChar(255), email)
        .query(`SELECT COUNT(*) AS count FROM Users WHERE email_address = @email`);

    if (userCheck.recordset[0].count > 0) {
        await pool.close();
        return { statusCode: 409, body: { status: 'error', error_message: 'The email address is already in use.' } };
    }

    // Clean expired tokens
    await pool.request()
        .input('email', sql.VarChar(255), email)
        .query(`DELETE FROM Tokens WHERE issued_at < DATEADD(HOUR, -48, GETDATE())`);

    // Pending invite check
    const tokenCheck = await pool.request()
        .input('email', sql.VarChar(255), email)
        .query(`SELECT COUNT(*) AS count FROM Tokens WHERE email = @email AND issued_at > DATEADD(HOUR, -48, GETDATE())`);

    if (tokenCheck.recordset[0].count > 0) {
        await pool.close();
        return { statusCode: 409, body: { status: 'error', error_message: 'The email address has a pending invite.' } };
    }

    const affiliateCode = await originCode(event);
    const signup_url = event.headers.origin || 'https://greenfieldsites.clubmadeira.io';

    const pin = generatePin();
    const expiry = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    const tokenPayload = {
        referrerId: user.user_id,
        expiry
    };

    let onboardingToken;
    try {
        onboardingToken = await signJWT(tokenPayload);
    } catch (err) {
        await pool.close();
        return { statusCode: 500, body: { status: 'error', error_message: 'Failed to generate onboarding token' } };
    }

    // Send email (mailer logic lives in ./email.js which uses the layer)
    const emailResult = await sendEmail(email, onboardingToken, normalizedPhone, signup_url, tokenType, url);
    if (!emailResult.success) {
        await pool.close();
        return { statusCode: 500, body: { status: 'error', error_message: 'Failed to send email' } };
    }

    // Send SMS via layer
    const smsMessage = `Your onboarding PIN is ${pin}. It expires in 48 hours.`;
    const smsSuccess = await sendSmsTextmagic(normalizedPhone, smsMessage);
    if (!smsSuccess) {
        await pool.close();
        return { statusCode: 500, body: { status: 'error', error_message: 'Failed to send PIN' } };
    }

    // Store token metadata
    const currentDate = new Date();
    await pool.request()
        .input('token_id', sql.VarChar(512), onboardingToken)
        .input('pin', sql.VarChar(6), pin)
        .input('phone', sql.VarChar(15), normalizedPhone)
        .input('email', sql.VarChar(255), email)
        .input('referrer_by', sql.Char(8), decoded.user_id)
        .input('issued_at', sql.DateTime, currentDate)
        .input('created_at', sql.DateTime, currentDate)
        .input('tokenType', sql.VarChar(50), tokenType)
        .input('signupurl', sql.VarChar(255), signup_url)
        .input('origin_code', sql.VarChar, affiliateCode)
        .input('url', sql.VarChar, url || communityId || null)
        .query(`
            INSERT INTO Tokens 
            (token_id, pin, phone, email, referrer_by, issued_at, created_at, validated, tokenType, signup_url, origin_code, url)
            VALUES 
            (@token_id, @pin, @phone, @email, @referrer_by, @issued_at, @created_at, 0, @tokenType, @signupurl, @origin_code, @url)
        `);

    await pool.close();

    logger.info('Onboarding token generated successfully', {
        email,
        tokenType,
        targetUrl: url || communityId
    });

    return {
        statusCode: 200,
        body: { status: 'success', message: 'Onboarding token generated successfully' }
    };
};