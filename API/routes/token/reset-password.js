// ====================== routes/token/reset-password.js ======================
const { logger, getDbConnection, sql } = require('/opt/nodejs/helpers');
const { sendSmsTextmagic } = require('/opt/nodejs/sms');

// Local helpers
const { getUserByEmail, generatePin } = require('./helpers');

async function canSendOtp(userId) {
    const pool = await getDbConnection();
    try {
        const threshold = new Date(Date.now() + 10 * 60 * 1000);
        const result = await pool.request()
            .input('user_id', sql.VarChar, userId)
            .input('threshold', sql.DateTime, threshold)
            .query(`SELECT TOP 1 1 FROM Otps WHERE user_id = @user_id AND expires_at > @threshold`);

        return result.recordset.length === 0;
    } finally {
        await pool.close();
    }
}

async function saveOtp(userId, email, otp, otpToken) {
    const pool = await getDbConnection();
    try {
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await pool.request()
            .input('otp_id', sql.VarChar, otpToken)
            .input('user_id', sql.VarChar, userId)
            .input('otp', sql.VarChar, otp)
            .input('email', sql.VarChar, email.toLowerCase())
            .input('expires_at', sql.DateTime, expiresAt)
            .query(`
                INSERT INTO Otps (otp_id, user_id, otp, email, expires_at)
                VALUES (@otp_id, @user_id, @otp, @email, @expires_at)
            `);
    } finally {
        await pool.close();
    }
}

module.exports = async (event) => {
    const body = event.body ? JSON.parse(event.body) : {};
    const { email } = body;

    if (!email) {
        return { statusCode: 400, body: { status: 'error', error_message: 'Email required' } };
    }

    const user = await getUserByEmail(email);
    if (!user) {
        return { statusCode: 404, body: { status: 'error', error_message: 'User not found' } };
    }

    const canSend = await canSendOtp(user.user_id);
    if (!canSend) {
        return { statusCode: 429, body: { status: 'error', error_message: 'Please wait before requesting a new OTP' } };
    }

    const otp = generatePin();
    const otpToken = require('crypto').randomUUID();

    await saveOtp(user.user_id, email, otp, otpToken);

    if (!user.phone_number) {
        return { statusCode: 400, body: { status: 'error', error_message: 'No phone number registered' } };
    }

    const message = `Your OTP for password reset is ${otp}. It expires in 15 minutes.`;
    const success = await sendSmsTextmagic(user.phone_number, message);

    if (!success) {
        return { statusCode: 500, body: { status: 'error', error_message: 'Failed to send OTP' } };
    }

    return {
        statusCode: 200,
        body: { status: 'success', message: 'OTP sent', otp_token: otpToken }
    };
};