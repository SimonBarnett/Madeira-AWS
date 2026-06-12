// ====================== routes/token/deleteconfirm.js ======================
const { logger, sql, getDbConnection } = require('/opt/nodejs/helpers');

module.exports = async (event) => {
    const body = event.body ? JSON.parse(event.body) : {};
    const decoded = event.decoded;

    const { otp } = body;
    if (!otp) {
        return { statusCode: 400, body: { status: 'error', error_message: 'OTP is required' } };
    }

    const pool = await getDbConnection();

    const otpCheck = await pool.request()
        .input('user_id', sql.VarChar(8), decoded.user_id)
        .input('otp', sql.VarChar(10), otp)
        .query(`SELECT * FROM deletion WHERE user_id = @user_id AND otp = @otp AND expires_at > GETDATE()`);

    if (otpCheck.recordset.length === 0) {
        await pool.close();
        return { statusCode: 400, body: { status: 'error', error_message: 'Invalid or expired OTP' } };
    }

    logger.info('Simulating user deletion', { userId: decoded.user_id });

    await pool.request()
        .input('user_id', sql.VarChar(8), decoded.user_id)
        .query(`DELETE FROM deletion WHERE user_id = @user_id`);

    await pool.close();

    return {
        statusCode: 200,
        body: { status: 'success', message: 'User deletion simulated successfully' }
    };
};