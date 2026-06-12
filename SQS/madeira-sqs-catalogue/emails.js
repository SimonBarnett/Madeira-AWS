// ====================== SQS/madeira-sqs-catalogue/emails.js ======================
// Email sending handlers for SQS messages
// Moved and adapted from the old API/routes/token/emails.js

const { sendMail } = require('/opt/nodejs/mailer');
const { logger, getS3Client, GetObjectCommand } = require('/opt/nodejs/helpers');
const QRCode = require('qrcode');

async function getImageBuffer(key) {
    try {
        const s3 = await getS3Client();
        const command = new GetObjectCommand({ Bucket: 'madeira-widget-bucket', Key: key });
        const response = await s3.send(command);
        const chunks = [];
        for await (const chunk of response.Body) chunks.push(chunk);
        return Buffer.concat(chunks);
    } catch (error) {
        logger.error('Failed to fetch image from S3', { key, error: error.message });
        throw error;
    }
}

// ====================== HANDLERS ======================

async function handleSendEmail(payload) {
    const { emailType, payload: data } = payload;

    switch (emailType) {
        case 'onboarding':
            return await sendOnboardingEmail(data);
        case 'delegation':
            return await sendDelegationEmail(data);
        case 'delegation_accepted':
            return await sendDelegationAcceptedEmail(data);
        case 'merchant_buy_url':
            return await sendMerchantBuyUrlEmail(data);
        case 'partner_onboarded':
            return await sendCPOnboardedEmail(data);
        default:
            logger.warn('Unknown emailType in SEND_EMAIL message', { emailType });
            return { success: false, reason: 'unknown_email_type' };
    }
}

// Placeholder implementations (full versions to be moved here)
async function sendOnboardingEmail(data) {
    logger.info('Would send onboarding email (SQS)', data);
    return { success: true };
}

async function sendDelegationEmail(data) {
    logger.info('Would send delegation email (SQS)', data);
    return { success: true };
}

async function sendDelegationAcceptedEmail(data) {
    logger.info('Would send delegation accepted email (SQS)', data);
    return { success: true };
}

async function sendMerchantBuyUrlEmail(data) {
    logger.info('Would send merchant buy URL email (SQS)', data);
    return { success: true };
}

async function sendCPOnboardedEmail(data) {
    logger.info('Would send partner onboarded email (SQS)', data);
    return { success: true };
}

module.exports = {
    handleSendEmail
};