// ====================== routes/token/tos.js ======================
// Serves Terms of Service from S3
// Bucket name comes from TOS_BUCKET environment variable

const { logger, getS3Client, GetObjectCommand, executeWithRetry, sql } = require('/opt/nodejs/helpers');

const streamToString = (stream) => {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
};

module.exports = async (event, { pool, sandbox = false } = {}) => {
    const queryParams = event.queryStringParameters || {};
    const onboardingToken = queryParams.token || null;
    const service = queryParams.service || null;

    if (!onboardingToken && !service) {
        return { statusCode: 400, body: { status: 'error', error_message: 'Token or service is required' } };
    }

    let type = service;

    // If token is provided, look up the token type from DB using passed pool
    if (onboardingToken) {
        try {
            const result = await executeWithRetry(() =>
                pool.request()
                    .input('token_id', sql.VarChar(512), onboardingToken)
                    .query('SELECT tokenType FROM Tokens WHERE token_id = @token_id')
            );

            if (result.recordset.length === 0) {
                return { statusCode: 404, body: { status: 'error', error_message: 'Token not found' } };
            }
            type = result.recordset[0].tokenType;
        } catch (err) {
            logger.error('Error looking up token type', { onboardingToken, error: err.message });
            return { statusCode: 500, body: { status: 'error', error_message: 'Error validating token' } };
        }
    }

    // Determine the S3 key based on type
    let key;
    if (type === 'partner') {
        key = 'partner_tos.txt';
    } else if (type === 'community') {
        key = 'community_tos.txt';
    } else if (type === 'merchant') {
        key = 'merchant_tos.txt';
    } else {
        return { statusCode: 400, body: { status: 'error', error_message: 'Invalid tokenType or service' } };
    }

    const bucket = process.env.TOS_BUCKET;
    if (!bucket) {
        logger.error('TOS_BUCKET environment variable is not set');
        return { statusCode: 500, body: { status: 'error', error_message: 'TOS bucket not configured' } };
    }

    try {
        const s3 = await getS3Client();
        const command = new GetObjectCommand({ Bucket: bucket, Key: key });

        const response = await s3.send(command);
        const text = await streamToString(response.Body);

        if (sandbox) logger.debug('[SANDBOX] ToS served from S3', { type, key });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'text/plain' },
            body: text
        };
    } catch (err) {
        logger.error('Error fetching terms from S3', { bucket, key, error: err.message });
        return { statusCode: 500, body: { status: 'error', error_message: 'Error fetching terms' } };
    }
};