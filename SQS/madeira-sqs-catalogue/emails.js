// ====================== SQS/madeira-sqs-catalogue/emails.js ======================
// Merged email module
// Contains:
// - Clubscan success/failure emails (used by Clubscan pipeline)
// - Onboarding/Delegation/Merchant emails (triggered via SEND_EMAIL SQS messages)

const { sendMail } = require('/opt/nodejs/mailer');
const { logger, getS3Client, GetObjectCommand } = require('/opt/nodejs/helpers');
const QRCode = require('qrcode');

// ====================== SHARED HELPERS ======================

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

// ====================== CLUBSCAN EMAILS (existing) ======================

async function sendSuccessEmail(toEmails, clubId, url) {
    let recipients = toEmails;
    if (typeof recipients === 'string') {
        recipients = recipients.split(',').map(e => e.trim()).filter(Boolean);
    }

    if (!Array.isArray(recipients) || recipients.length === 0) {
        logger.warn('No valid emails to send success email to', { url });
        return { success: false };
    }

    const widgetCode = `<div id="madeira-container"></div><script data-affiliate="${clubId}" data-css="madeira-widget.css" src="https://madeira-widget-bucket.s3.eu-west-2.amazonaws.com/madeira-widget.js?v=1.0"></script>`;
    const escapedWidgetCode = widgetCode.replace(/</g, '<').replace(/>/g, '>');

    const mailOptions = {
        from: 'support@clubmadeira.uk',
        to: recipients,
        subject: `${url} Widget Code`,
        text: `Onboarding of ${url} is now complete.\n\nHere is the widget code for the community site:\n\n${widgetCode}\n\nBest regards,\nThe Club Madeira Team`,
        html: `
            <p>Onboarding of <strong>${url}</strong> is now complete.</p>
            <p>Here is the widget code for the community site:</p>
            <pre style="background:#f4f4f4;padding:15px;border-radius:6px;">${escapedWidgetCode}</pre>
            <p>Best regards,<br>The Club Madeira Team</p>
        `
    };

    try {
        const result = await sendMail(mailOptions);
        logger.debug('✅ Success email sent', { recipients, url });
        return result;
    } catch (error) {
        logger.error('Failed to send success email', { recipients, url, error: error.message });
        return { success: false, reason: error.message };
    }
}

async function sendFailureEmail(toEmails, url, errorMessage) {
    let recipients = toEmails;
    if (typeof recipients === 'string') {
        recipients = recipients.split(',').map(e => e.trim()).filter(Boolean);
    }

    if (!Array.isArray(recipients) || recipients.length === 0) {
        logger.warn('No valid recipients for failure email', { url });
        return { success: false };
    }

    const mailOptions = {
        from: 'noreply@clubmadeira.uk',
        to: recipients,
        subject: `Failure in Processing URL: ${url}`,
        text: `Failed to process ${url}:\n\n${errorMessage}`,
        html: `
            <p><strong>Failed to process ${url}</strong></p>
            <p>${errorMessage}</p>
        `
    };

    try {
        const result = await sendMail(mailOptions);
        logger.debug('✅ Failure email sent', { recipients, url });
        return result;
    } catch (error) {
        logger.error('Failed to send failure email', { url, error: error.message });
        return { success: false, reason: error.message };
    }
}

// ====================== NEW EMAILS (from token/emails.js) ======================

async function handleSendEmail(payload) {
    const { emailType, payload: data = {} } = payload;

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
            logger.warn('Unknown emailType in SEND_EMAIL', { emailType });
            return { success: false, reason: 'unknown_email_type' };
    }
}

async function sendOnboardingEmail({ email, token, phone, signup_url, tokenType, url }) {
    if (!email || !token || !phone || !signup_url || !tokenType) {
        return { success: false, reason: 'missing_required_fields' };
    }

    const lastFourDigits = phone.slice(-4);
    const signupUrlWithPage = new URL(`${signup_url}/signup.html`);
    signupUrlWithPage.searchParams.append('token', token);
    signupUrlWithPage.searchParams.append('v', '1.1');
    const signupUrlWithTokenString = signupUrlWithPage.toString();

    const qrBuffer = await QRCode.toBuffer(signupUrlWithTokenString, { errorCorrectionLevel: 'H' });

    let subject = '';
    let html = '';
    let imageKey = '';
    let cid = '';

    if (tokenType === 'community') {
        imageKey = 'community.png';
        cid = 'communityLogo';
        subject = 'Club Madeira Community Programme Invite!';
        html = `<img src="cid:${cid}" alt="Community Logo" /><p><b>Hello,</b><br>${url} has been invited to participate in the Club Madeira community programme.</p><p>You will receive a separate PIN to the mobile number ending ${lastFourDigits}.</p><p>This link expires in 48 hours, so please <a href="${signupUrlWithTokenString}">complete sign up</a> soon!</p><p>Or scan this QR code:</p><img src="cid:qrcode" alt="Signup QR Code" style="width:200px;height:200px;" />`;
    } else if (tokenType === 'merchant') {
        imageKey = 'merchant.png';
        cid = 'merchantLogo';
        subject = 'Club Madeira Merchant Programme Invite!';
        html = `<img src="cid:${cid}" alt="Merchant Logo" /><p><b>Hello,</b> you've been invited to participate in the Club Madeira merchant programme.</p><p>You will receive a separate PIN to the mobile number ending ${lastFourDigits}.</p><p>This link expires in 48 hours, so please <a href="${signupUrlWithTokenString}">complete sign up</a> soon!</p><p>Or scan this QR code:</p><img src="cid:qrcode" alt="Signup QR Code" style="width:200px;height:200px;" />`;
    } else if (tokenType === 'partner') {
        imageKey = 'partner.png';
        cid = 'partnerLogo';
        subject = 'Club Madeira Partner Programme Invite!';
        html = `<img src="cid:${cid}" alt="Partner Logo" /><p><b>Hello,</b> you've been invited to become a Club Madeira partner.</p><p>You will receive a separate PIN to the mobile number ending ${lastFourDigits}.</p><p>This link expires in 48 hours, so please <a href="${signupUrlWithTokenString}">complete sign up</a> soon!</p><p>Or scan this QR code:</p><img src="cid:qrcode" alt="Signup QR Code" style="width:200px;height:200px;" />`;
    } else {
        return { success: false, reason: 'invalid_token_type' };
    }

    const imageBuffer = await getImageBuffer(imageKey);
    const qrBase64 = qrBuffer.toString('base64');

    const mailOptions = {
        from: 'support@clubmadeira.uk',
        to: email,
        subject,
        html,
        attachments: [
            { filename: imageKey, content: imageBuffer.toString('base64'), encoding: 'base64', cid },
            { filename: 'qrcode.png', content: qrBase64, encoding: 'base64', cid: 'qrcode' }
        ]
    };

    try {
        await sendMail(mailOptions);
        logger.info('Onboarding email sent successfully', { email, tokenType });
        return { success: true };
    } catch (error) {
        logger.error('Failed to send onboarding email', { email, error: error.message });
        return { success: false, reason: error.message };
    }
}

async function sendDelegationEmail({ email, token, phone, signup_url, url }) {
    logger.info('Delegation email (placeholder - full implementation can be added)', { email });
    return { success: true };
}

async function sendDelegationAcceptedEmail({ new_email, old_email }) {
    logger.info('Delegation accepted email (placeholder)', { new_email });
    return { success: true };
}

async function sendMerchantBuyUrlEmail({ merchantEmail, url, jsonResult, pdfBase64 }) {
    logger.info('Merchant buy URL email (placeholder)', { merchantEmail });
    return { success: true };
}

async function sendCPOnboardedEmail({ partnerEmail, url, partnerId }) {
    logger.info('Partner onboarded email (placeholder)', { partnerEmail });
    return { success: true };
}

// ====================== EXPORTS ======================

module.exports = {
    // Clubscan emails
    sendSuccessEmail,
    sendFailureEmail,

    // New email system
    handleSendEmail
};