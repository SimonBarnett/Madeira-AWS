// ====================== routes/token/delegate.js ======================
// Handles account delegation initiation
// Uses new layers + local helpers
// Last updated: 02 June 2026

const { logger, sql, getDbConnection } = require('/opt/nodejs/helpers');
const { signJWT } = require('/opt/nodejs/jwt');
const { sendDelegationEmail } = require('./email');
const { sendSmsTextmagic } = require('/opt/nodejs/sms');

// Local helpers
const { 
    generatePin, 
    normalizePhone, 
    isValidPhone, 
    isValidEmail, 
    getUserById 
} = require('./helpers');

module.exports = async (event) => {
    const body = event.body ? JSON.parse(event.body) : {};
    const decoded = event.decoded;

    const { first_name, phone_number, email_address } = body;

    if (!first_name || !phone_number || !email_address) {
        return { statusCode: 400, body: { status: 'error', error_message: 'Missing required fields' } };
    }

    const normalizedPhone = normalizePhone(phone_number);
    if (!isValidPhone(normalizedPhone) || !isValidEmail(email_address)) {
        return { statusCode: 400, body: { status: 'error', error_message: 'Invalid phone or email format' } };
    }

    const user = await getUserById(decoded.user_id, event);
    if (!user) {
        return { statusCode: 404, body: { status: 'error', error_message: 'User not found' } };
    }

    const signup_url = event.headers.origin || 'https://greenfieldsites.clubmadeira.io';

    const pool = await getDbConnection();

    // Check if email already exists
    const userCheck = await pool.request()
        .input('email', sql.VarChar(255), email_address)
        .query(`SELECT COUNT(*) AS count FROM Users WHERE email_address = @email`);

    if (userCheck.recordset[0].count > 0) {
        await pool.close();
        return { statusCode: 409, body: { status: 'error', error_message: 'Email already in use' } };
    }

    // Clean expired delegations + duplicate check
    await pool.request().query(`DELETE FROM delegation WHERE created_at < DATEADD(HOUR, -48, GETDATE())`);

    const delegationCheck = await pool.request()
        .input('email', sql.VarChar(255), email_address)
        .query(`SELECT user_id FROM delegation WHERE email_address = @email`);

    if (delegationCheck.recordset.length > 0) {
        await pool.close();
        return { statusCode: 409, body: { status: 'error', error_message: 'Pending delegation exists' } };
    }

    const otp = generatePin();
    const expiry = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    const delegationToken = await signJWT({
        delegatorId: user.user_id,
        expiry
    });

    // Send email
    const emailResult = await sendDelegationEmail(email_address, delegationToken, normalizedPhone, signup_url, user.communityUrl || '');
    if (!emailResult.success) {
        await pool.close();
        return { statusCode: 500, body: { status: 'error', error_message: 'Failed to send email' } };
    }

    // Send SMS via new SMS layer
    const smsMessage = `Your delegation OTP is ${otp}. It expires in 48 hours.`;
    const smsSuccess = await sendSmsTextmagic(normalizedPhone, smsMessage);
    if (!smsSuccess) {
        await pool.close();
        return { statusCode: 500, body: { status: 'error', error_message: 'Failed to send OTP' } };
    }

    // Store delegation record
    const currentDate = new Date();
    await pool.request()
        .input('token', sql.NVarChar(sql.MAX), delegationToken)
        .input('user_id', sql.Char(8), decoded.user_id)
        .input('otp', sql.VarChar(6), otp)
        .input('first_name', sql.VarChar(50), first_name)
        .input('email_address', sql.VarChar(255), email_address)
        .input('phone_number', sql.VarChar(20), normalizedPhone)
        .input('created_at', sql.DateTime2, currentDate)
        .query(`
            INSERT INTO delegation (token, user_id, otp, first_name, email_address, phone_number, created_at)
            VALUES (@token, @user_id, @otp, @first_name, @email_address, @phone_number, @created_at)
        `);

    await pool.close();

    logger.info('Delegation initiated successfully', { email: email_address });

    return {
        statusCode: 200,
        body: { status: 'success', message: 'Delegation initiated successfully' }
    };
};