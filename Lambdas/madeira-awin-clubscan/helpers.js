// helpers.js
const { SSMClient, GetParametersCommand } = require("@aws-sdk/client-ssm");
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const bcrypt = require('bcryptjs');
const sql = require('mssql');

// ====================== Logger ======================
const winston = require('winston');
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [new winston.transports.Console()],
    defaultMeta: { service: 'madeira-awin-clubscan' }
});

// ====================== SSM PARAMETER STORE DB CONFIG (NEW) ======================
let dbConfigCache = null;
let dbConfigCacheTime = 0;

async function getDbConfig() {
    const now = Date.now();

    // Use cache if still fresh (30 minutes)
    if (dbConfigCache && (now - dbConfigCacheTime < 1800000)) {
        logger.debug('✅ Using cached DB config from SSM');
        return dbConfigCache;
    }

    logger.info('🔄 Fetching DB config from SSM Parameter Store');

    try {
        const client = new SSMClient({ region: "eu-west-2" });

        const command = new GetParametersCommand({
            Names: [
                '/madeira/db/user',
                '/madeira/db/password',
                '/madeira/db/server',
                '/madeira/db/name'
            ],
            WithDecryption: true
        });

        const response = await client.send(command);

        const config = {};
        response.Parameters.forEach(param => {
            const key = param.Name.split('/').pop(); // user, password, server, name
            config[key] = param.Value;
        });

        // Cache it
        dbConfigCache = config;
        dbConfigCacheTime = now;

        logger.info('✅ DB config successfully loaded from SSM Parameter Store');
        return config;

    } catch (error) {
        logger.error('Failed to fetch DB config from SSM', { error: error.message });
        throw new Error(`SSM Parameter Store failed: ${error.message}`);
    }
}

async function getDbConnection() {
    try {
        const config = await getDbConfig();
        const pool = await sql.connect({
            user: config.user,
            password: config.password,
            server: config.server,
            database: config.name,
            options: {
                encrypt: true,
                trustServerCertificate: true,
                requestTimeout: 300000 // 5 minutes timeout
            }
        });
        logger.debug('Database connection established');
        return pool;
    } catch (error) {
        logger.error('Database connection failed', { error: error.message, stack: error.stack });
        throw new Error(`Database connection failed: ${error.message}`);
    }
}

// ====================== Grok API Call (FIXED) ======================
async function callXaiApi(messages, schema = null) {
    try {
        const grokPayload = { messages };
        if (schema) {
            grokPayload.schema = schema;   // ← This is what was missing
        }

        const lambdaClient = new LambdaClient();
        const command = new InvokeCommand({
            FunctionName: process.env.GROK_LAMBDA_NAME || "madeira-grok",
            InvocationType: 'RequestResponse',
            Payload: JSON.stringify(grokPayload)
        });

        const response = await lambdaClient.send(command);

        if (response.FunctionError) {
            logger.error('Grok Lambda returned function error', { functionError: response.FunctionError });
            return null;
        }

        const body = JSON.parse(new TextDecoder().decode(response.Payload));
        if (body.error) {
            logger.error('Grok returned error', { error: body.error });
            return null;
        }
        return body;
    } catch (error) {
        logger.error('callXaiApi failed', { error: error.message, stack: error.stack });
        return null;
    }
}

// ====================== Email ======================
async function invokeMailer(mailOptions) {
    const lambdaClient = new LambdaClient();
    const command = new InvokeCommand({
        FunctionName: process.env.MAILER_LAMBDA_NAME || "madeira-mailer",
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({ mailOptions })
    });
    const response = await lambdaClient.send(command);
    if (response.FunctionError) throw new Error('Failed to send email');
    logger.info('Email sent successfully');
    return true;
}

// ====================== Global Mode Tracking ======================
async function getAlreadyRecommendedMerchants(pool) {
    try {
        const result = await pool.request()
            .query(`
                SELECT MerchantId 
                FROM AwinRecommendedMerchants 
                WHERE Mode = 'global' 
                AND SentAt >= DATEADD(DAY, -90, GETDATE())
            `);
        return new Set(result.recordset.map(r => r.MerchantId));
    } catch (error) {
        logger.error('Failed to get already recommended merchants', { error: error.message });
        return new Set();
    }
}

async function recordRecommendedMerchants(pool, merchantIds) {
    if (!merchantIds || merchantIds.length === 0) return;
    try {
        const values = merchantIds.map(id => `(${id}, 'global')`).join(',');
        await pool.request().query(`
            INSERT INTO AwinRecommendedMerchants (MerchantId, Mode)
            VALUES ${values}
        `);
        logger.info('Recorded recommended merchants for global mode', { count: merchantIds.length });
    } catch (error) {
        logger.error('Failed to record recommended merchants', { error: error.message });
    }
}

function generateUserId() {
    const charset = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 7; i++) {
        const randomIndex = Math.floor(Math.random() * charset.length);
        code += charset[randomIndex];
    }
    let total = 0;
    for (let char of code) {
        total += charset.indexOf(char);
    }
    const checksum = charset[total % 36];
    return code + checksum;
}
async function isUserIdUnique(userId) {
    const pool = await getDbConnection();
    try {
        const result = await pool.request()
            .input('user_id', sql.VarChar, userId)
            .query('SELECT COUNT(*) as count FROM Users WHERE user_id = @user_id');
        return result.recordset[0].count === 0;
    } catch (error) {
        logger.error('Failed to check user_id uniqueness', { userId, error: error.message });
        throw error;
    } finally {
        pool.close();
    }
}

// ====================== Create Awin Merchant User (FINAL - EXACTLY AS REQUESTED) ======================
async function createAwinMerchantUser({ advertiserId, name, website }) {
    const pool = await getDbConnection();

    try {
        const userId = generateUserId();
        const email = `${advertiserId}@awin.com`;
        const plainPassword = String(advertiserId);
        const hashedPassword = await bcrypt.hash(plainPassword, 10);

        logger.info('Creating Awin merchant user', { 
            advertiserId, 
            name, 
            userId, 
            email,
            passwordUsed: plainPassword,
            role: 'merchant'
        });

        await pool.request()
            .input('userId', sql.VarChar(20), userId)
            .input('email', sql.VarChar(255), email)
            .input('name', sql.VarChar(255), name || 'Awin Merchant')
            .input('website', sql.VarChar(500), website || null)
            .input('hashedPassword', sql.VarChar(255), hashedPassword)
            .input('phoneNumber', sql.VarChar(20), '+447989389179')
            .query(`
                MERGE INTO Users AS target
                USING (SELECT @userId AS user_id, @email AS email_address) AS source
                ON target.user_id = source.user_id
                WHEN MATCHED THEN
                    UPDATE SET 
                        email_address = source.email_address,
                        first_name    = COALESCE(target.first_name, @name),
                        last_name     = 'Merchant',
                        company_name  = @name,
                        website_url   = @website,
                        password      = @hashedPassword,
                        permissions   = '["merchant"]',
                        role          = 'merchant',
                        phone_number  = @phoneNumber,
                        signupurl     = 'https://awin.com/',
                        updated_at    = GETDATE()
                WHEN NOT MATCHED THEN
                    INSERT (
                        user_id, email_address, first_name, last_name, 
                        company_name, website_url, password, 
                        permissions, role, phone_number, signupurl, 
                        created_at, updated_at
                    )
                    VALUES (
                        @userId, @email, @name, 'Merchant', 
                        @name, @website, @hashedPassword, 
                        '["merchant"]', 'merchant', @phoneNumber, 'https://awin.com/', 
                        GETDATE(), GETDATE()
                    );
            `);

        logger.info('✅ Awin merchant user created successfully', { 
            userId, 
            email, 
            advertiserId,
            role: 'merchant',
            permissions: '["merchant"]',
            phone_number: '+447989389179',
            signupurl: 'https://awin.com/'
        });

        return { userId, email };

    } catch (error) {
        logger.error('Failed to create Awin merchant user', { 
            advertiserId, 
            name, 
            error: error.message, 
            stack: error.stack 
        });
        throw error;
    } finally {
        await pool.close();
    }
}

module.exports = {
    logger,
    getDbConnection,
    callXaiApi,
    invokeMailer,
    getAlreadyRecommendedMerchants,
    recordRecommendedMerchants,
    createAwinMerchantUser,
    generateUserId,        // ← add this if not already exported
    isUserIdUnique         // ← add this if not already exported
};