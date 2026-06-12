// ====================== routes/token/acceptdelegation.js ======================
const { logger, sql, getDbConnection, hashPassword } = require('/opt/nodejs/helpers');
const { signJWT, verifyJWT } = require('/opt/nodejs/jwt');
const { sendDelegationAcceptedEmail } = require('./email');

// Local helpers
const { setLastLogin, getUserById } = require('./helpers');

module.exports = async (event) => {
    const body = event.body ? JSON.parse(event.body) : {};
    const { token, otp, newpassword } = body;

    if (!token || !otp || !newpassword) {
        return { statusCode: 400, body: { status: 'error', error_message: 'Token, OTP and new password are required' } };
    }

    let decoded;
    try {
        decoded = await verifyJWT(token);
    } catch (err) {
        return { statusCode: 401, body: { status: 'error', error_message: 'Invalid token' } };
    }

    const user_id = decoded.delegatorId;
    const expiry = new Date(decoded.expiry);
    if (expiry < new Date()) {
        return { statusCode: 400, body: { status: 'error', error_message: 'Token expired' } };
    }

    const pool = await getDbConnection();

    const delegationResult = await pool.request()
        .input('token', sql.NVarChar(sql.MAX), token)
        .input('user_id', sql.Char(8), user_id)
        .input('otp', sql.VarChar(6), otp)
        .query(`SELECT * FROM delegation WHERE token = @token AND user_id = @user_id AND otp = @otp AND created_at > DATEADD(HOUR, -48, GETDATE())`);

    if (delegationResult.recordset.length === 0) {
        await pool.close();
        return { statusCode: 400, body: { status: 'error', error_message: 'Invalid delegation details' } };
    }

    const delegation = delegationResult.recordset[0];

    // Use layer's hashPassword (bcrypt with salt rounds 12)
    const hashedPassword = await hashPassword(newpassword);

    await pool.request()
        .input('first_name', sql.VarChar(50), delegation.first_name)
        .input('email_address', sql.VarChar(255), delegation.email_address)
        .input('phone_number', sql.VarChar(20), delegation.phone_number)
        .input('password', sql.VarChar(255), hashedPassword)
        .input('user_id', sql.Char(8), user_id)
        .query(`UPDATE Users SET first_name = @first_name, email_address = @email_address, phone_number = @phone_number, password = @password WHERE user_id = @user_id`);

    await pool.request()
        .input('user_id', sql.Char(8), user_id)
        .query(`DELETE FROM delegation WHERE user_id = @user_id`);

    await sendDelegationAcceptedEmail(delegation.email_address, '');

    const user = await getUserById(user_id, event);

    const jwtToken = await signJWT({
        user_id: user.user_id,
        permissions: user.permissions,
        exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60)
    });

    await setLastLogin(user.user_id, event.requestContext?.identity?.sourceIp);
    await pool.close();

    return {
        statusCode: 200,
        body: {
            status: 'success',
            token: jwtToken,
            user_id: user.user_id,
            contact_name: user.company_name || user.first_name || 'User',
            workflow: 'login'
        }
    };
};