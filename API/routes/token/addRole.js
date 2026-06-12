// ====================== routes/token/addRole.js ======================
const { logger, sql, getDbConnection } = require('/opt/nodejs/helpers');
const { signJWT } = require('/opt/nodejs/jwt');

// Local helpers
const { getUserById } = require('./helpers');

module.exports = async (event) => {
    const body = event.body ? JSON.parse(event.body) : {};
    const decoded = event.decoded;

    const { role, agreedToTos } = body;

    if (!role || role !== 'merchant' || agreedToTos !== true) {
        return {
            statusCode: 400,
            body: { status: 'error', error_message: 'role must be "merchant" and agreedToTos must be true' }
        };
    }

    const user = await getUserById(decoded.user_id, event);
    if (!user) {
        return { statusCode: 404, body: { status: 'error', error_message: 'User not found' } };
    }

    let permissions = [...user.permissions];
    let message;

    if (permissions.includes('merchant')) {
        message = 'User already has the merchant permission';
    } else {
        permissions.push('merchant');

        const pool = await getDbConnection();
        await pool.request()
            .input('user_id', sql.Char(8), user.user_id)
            .input('permissions', sql.VarChar(255), JSON.stringify(permissions))
            .query('UPDATE Users SET permissions = @permissions, updated_at = GETDATE() WHERE user_id = @user_id');
        await pool.close();

        message = 'Merchant permission added successfully';
    }

    const token = await signJWT({
        user_id: user.user_id,
        permissions: user.permissions,
        exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60)
    });

    return {
        statusCode: 200,
        body: { status: 'success', message, token }
    };
};