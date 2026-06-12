// ====================== routes/token/verify-reset-code.js ======================
const { logger, getDbConnection, sql } = require('/opt/nodejs/helpers');
const { signJWT } = require('/opt/nodejs/jwt');
const { hashPassword } = require('/opt/nodejs/helpers');

// Local helpers
const { getUserById, updateUserPassword, getLastLogin, setLastLogin } = require('./helpers');

async function verifyOtp(otpToken, otp, email) {
    const pool = await getDbConnection();
    try {
        const result = await pool.request()
            .input('otp_id', sql.VarChar, otpToken)
            .input('otp', sql.VarChar, otp)
            .input('email', sql.VarChar, email.toLowerCase())
            .query(`SELECT user_id, expires_at FROM Otps WHERE otp_id = @otp_id AND otp = @otp AND email = @email`);

        if (result.recordset.length === 0) return null;
        const record = result.recordset[0];
        if (new Date() > new Date(record.expires_at)) return null;
        return record.user_id;
    } finally {
        await pool.close();
    }
}

async function deleteOtp(otpToken) {
    const pool = await getDbConnection();
    try {
        await pool.request()
            .input('otp_id', sql.VarChar, otpToken)
            .query(`DELETE FROM Otps WHERE otp_id = @otp_id`);
    } finally {
        await pool.close();
    }
}

module.exports = async (event) => {
    const body = event.body ? JSON.parse(event.body) : {};
    const { email, otp, new_password, confirm_new_password, otp_token } = body;

    if (!email || !otp || !new_password || !confirm_new_password || !otp_token) {
        return { statusCode: 400, body: { status: 'error', error_message: 'Missing required fields' } };
    }

    if (new_password !== confirm_new_password) {
        return { statusCode: 400, body: { status: 'error', error_message: 'Passwords do not match' } };
    }

    const userId = await verifyOtp(otp_token, otp, email);
    if (!userId) {
        return { statusCode: 400, body: { status: 'error', error_message: 'Invalid or expired OTP' } };
    }

    const user = await getUserById(userId, event);
    if (!user) {
        return { statusCode: 400, body: { status: 'error', error_message: 'Invalid user' } };
    }

    const hashedPassword = await hashPassword(new_password);
    await updateUserPassword(userId, hashedPassword);
    await deleteOtp(otp_token);

    const token = await signJWT({
        user_id: user.user_id,
        permissions: user.permissions,
        exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60)
    });

    const lastLogin = await getLastLogin(user.user_id);
    let lastLoginMessage;
    if (lastLogin) {
        lastLoginMessage = `You last logged in at ${new Date(lastLogin.timestamp).toLocaleString('en-GB')} from ${lastLogin.IP}.`;
    }

    await setLastLogin(user.user_id, event.requestContext?.identity?.sourceIp);

    return {
        statusCode: 200,
        body: {
            status: 'success',
            token,
            user_id: user.user_id,
            contact_name: user.company_name || user.first_name || 'User',
            workflow: 'login',
            ...(lastLoginMessage && { lastlogin: lastLoginMessage })
        }
    };
};