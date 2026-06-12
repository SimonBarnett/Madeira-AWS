// ====================== nodejs/mailer.js ======================
// Email sender with embedded footer images (S3)
// Last updated: 11 June 2026

const nodemailer = require('nodemailer');
const { 
    getS3Client, 
    GetObjectCommand, 
    getMailerConfig, 
    logger 
} = require('/opt/nodejs/helpers');           // ← FIXED: Use absolute path

async function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

async function getImageBuffer(key, bucket) {
    const s3 = await getS3Client();
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });

    try {
        const response = await s3.send(command);
        return await streamToBuffer(response.Body);
    } catch (err) {
        logger.error(`Failed to fetch email image from S3: ${key}`, { error: err.message });
        throw new Error(`Missing email asset: ${key}`);
    }
}

async function sendMail(mailOptions) {
    const transactionId = `mail-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    if (!mailOptions?.from || !mailOptions?.to || !mailOptions?.subject) {
        logger.error('Email send failed - missing required fields', { transactionId });
        throw new Error('Missing required mailOptions fields: from, to, subject');
    }

    logger.info('📧 Sending email', {
        transactionId,
        to: mailOptions.to,
        subject: mailOptions.subject
    });

    try {
        const config = await getMailerConfig();

        if (!config.EMAIL_USER || !config.EMAIL_PASS || config.EMAIL_USER === "CHANGE_ME") {
            throw new Error('Mailer credentials not configured (EMAIL_USER / EMAIL_PASS)');
        }

        const transporter = nodemailer.createTransport({
            host: config.EMAIL_HOST,
            port: config.EMAIL_PORT,
            secure: false,
            auth: {
                user: config.EMAIL_USER,
                pass: config.EMAIL_PASS
            }
        });

        const [supportBuffer, appleBuffer, chromeBuffer] = await Promise.all([
            getImageBuffer('supportyourclub.png', config.EMAIL_BUCKET),
            getImageBuffer('applestore.png', config.EMAIL_BUCKET),
            getImageBuffer('chromestore.png', config.EMAIL_BUCKET)
        ]);

        const footerHtml = `
            <p>Club Madeira Ltd<br>
            Ground Floor, Citygate<br>
            Longridge Road, Preston<br>
            Lancashire PR2 5BQ<br>
            United Kingdom<br>
            Email: support@clubmadeira.uk<br>
            Phone: 01772 369955</p>
            <img src="cid:supportyourclub" height="50">&nbsp;
            <a href="https://apps.apple.com/us/app/madeira-affiliate-extension/id6751989113">
                <img src="cid:applestore" height="50">
            </a>
            <a href="https://chromewebstore.google.com/detail/club-madeira-affiliate-ex/ilnlmljfigjdlfppgnkffmlpmpdaiegc">
                <img src="cid:chromestore" height="50">
            </a>`;

        if (mailOptions.html) {
            mailOptions.html += footerHtml;
        }

        if (!mailOptions.attachments) mailOptions.attachments = [];
        mailOptions.attachments.push(
            { filename: 'supportyourclub.png', content: supportBuffer, encoding: 'base64', cid: 'supportyourclub' },
            { filename: 'applestore.png', content: appleBuffer, encoding: 'base64', cid: 'applestore' },
            { filename: 'chromestore.png', content: chromeBuffer, encoding: 'base64', cid: 'chromestore' }
        );

        const info = await transporter.sendMail(mailOptions);

        logger.info('✅ Email sent successfully', {
            transactionId,
            messageId: info.messageId,
            to: mailOptions.to
        });

        return { success: true, messageId: info.messageId };

    } catch (error) {
        logger.error('❌ Email sending failed', {
            transactionId,
            to: mailOptions?.to,
            error: error.message
        });
        throw error;
    }
}

module.exports = { sendMail };