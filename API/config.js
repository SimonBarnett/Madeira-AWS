const winston = require('winston');

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    transports: [new winston.transports.Console()],
    defaultMeta: { service: 'auth-lambda' }
});

const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: { encrypt: true, trustServerCertificate: true }
};

const TEXTMAGIC = {
    API_URL: process.env.TEXTMAGIC_URL || 'https://rest.textmagic.com/api/v2/messages',
    USERNAME: process.env.TEXTMAGIC_USERNAME,
    API_KEY: process.env.TEXTMAGIC_API_KEY
};

const JWT_SECRET_KEY = process.env.JWT_SECRET_KEY;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_HOST = process.env.EMAIL_HOST;
const EMAIL_PORT = process.env.EMAIL_PORT || '587';

logger.info('Environment variables', {
    env: {
        DB_USER: process.env.DB_USER ? '[set]' : '[unset]',
        DB_PASSWORD: process.env.DB_PASSWORD ? '[set]' : '[unset]',
        DB_SERVER: process.env.DB_SERVER ? '[set]' : '[unset]',
        DB_NAME: process.env.DB_NAME ? '[set]' : '[unset]',
        JWT_SECRET_KEY: process.env.JWT_SECRET_KEY ? '[set]' : '[unset]',
        TEXTMAGIC_USERNAME: process.env.TEXTMAGIC_USERNAME ? '[set]' : '[unset]',
        TEXTMAGIC_API_KEY: process.env.TEXTMAGIC_API_KEY ? '[set]' : '[unset]',
        TEXTMAGIC_URL: process.env.TEXTMAGIC_URL,
        EMAIL_USER: process.env.EMAIL_USER ? '[set]' : '[unset]',
        EMAIL_PASS: process.env.EMAIL_PASS ? '[set]' : '[unset]',
        EMAIL_HOST: process.env.EMAIL_HOST,
        EMAIL_PORT: process.env.EMAIL_PORT,
        LOG_LEVEL: process.env.LOG_LEVEL,
        STRIPE_API_KEY: process.env.STRIPE_API_KEY ? '[set]' : '[unset]'
    }
});

module.exports = {
    logger,
    dbConfig,
    TEXTMAGIC,
    JWT_SECRET_KEY,
    EMAIL_USER,
    EMAIL_PASS,
    EMAIL_HOST,
    EMAIL_PORT
};