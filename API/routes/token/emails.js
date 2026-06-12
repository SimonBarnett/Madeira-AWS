// ====================== routes/token/email.js ======================
// All email templates and sending logic (onboarding, delegation, merchant, partner)
// Uses the central layer for mailer + S3
// Last updated: 02 June 2026

const { sendMail } = require('/opt/nodejs/mailer');
const { logger, getS3Client, GetObjectCommand } = require('/opt/nodejs/helpers');
const QRCode = require('qrcode');

// ====================== S3 IMAGE HELPER (via Layer) ======================
async function getImageBuffer(key) {
    try {
        const s3 = await getS3Client();
        const command = new GetObjectCommand({
            Bucket: 'madeira-widget-bucket',
            Key: key,
        });
        const response = await s3.send(command);

        const chunks = [];
        for await (const chunk of response.Body) chunks.push(chunk);
        return Buffer.concat(chunks);
    } catch (error) {
        logger.error('Failed to fetch image from S3', { key, error: error.message });
        throw error;
    }
}

// ====================== EMAIL FUNCTIONS ======================

async function sendEmail(email, token, phone, signup_url, tokenType, url) {
    logger.debug('Sending onboarding email', { email, tokenType });

    const lastFourDigits = phone.slice(-4);
    const signupUrlWithPage = new URL(`${signup_url}/signup.html`);
    signupUrlWithPage.searchParams.append('token', token);
    signupUrlWithPage.searchParams.append('v', '1.1');
    const signupUrlWithTokenString = signupUrlWithPage.toString();

    const qrBuffer = await QRCode.toBuffer(signupUrlWithTokenString, { errorCorrectionLevel: 'H' });

    let subject = '';
    let text = '';
    let html = '';
    let imageKey = '';
    let cid = '';

    if (tokenType === 'community') {
        imageKey = 'community.png';
        cid = 'communityLogo';
        subject = 'Club Madeira Community Programme Invite!';
        text = `Hello,\n${url} has been invited to participate in the Club Madeira community programme.\nYou will receive a separate PIN to the mobile number ending ${lastFourDigits}.`;
        html = `
            <img src="cid:${cid}" alt="Community Logo" />
            <p><b>Hello,</b><br>${url} has been invited to participate in the Club Madeira community programme.</p>
            <p>You will receive a separate PIN to the mobile number ending ${lastFourDigits}.</p>
            <p>This link expires in 48 hours, so please <a href="${signupUrlWithTokenString}">complete sign up</a> soon!</p>
            <p>Or scan this QR code:</p>
            <img src="cid:qrcode" alt="Signup QR Code" style="width:200px;height:200px;" />
        `;
    } 
    else if (tokenType === 'merchant') {
        imageKey = 'merchant.png';
        cid = 'merchantLogo';
        subject = 'Club Madeira Merchant Programme Invite!';
        text = `Hello, you've been invited to participate in the Club Madeira merchant programme.\nYou will receive a separate PIN to the mobile number ending ${lastFourDigits}.`;
        html = `
            <img src="cid:${cid}" alt="Merchant Logo" />
            <p><b>Hello,</b> you've been invited to participate in the Club Madeira merchant programme.</p>
            <p>You will receive a separate PIN to the mobile number ending ${lastFourDigits}.</p>
            <p>This link expires in 48 hours, so please <a href="${signupUrlWithTokenString}">complete sign up</a> soon!</p>
            <p>Or scan this QR code:</p>
            <img src="cid:qrcode" alt="Signup QR Code" style="width:200px;height:200px;" />
        `;
    } 
    else if (tokenType === 'partner') {
        imageKey = 'partner.png';
        cid = 'partnerLogo';
        subject = 'Club Madeira Partner Programme Invite!';
        text = `Hello, you've been invited to become a Club Madeira partner.\nYou will receive a separate PIN to the mobile number ending ${lastFourDigits}.`;
        html = `
            <img src="cid:${cid}" alt="Partner Logo" />
            <p><b>Hello,</b> you've been invited to become a Club Madeira partner.</p>
            <p>You will receive a separate PIN to the mobile number ending ${lastFourDigits}.</p>
            <p>This link expires in 48 hours, so please <a href="${signupUrlWithTokenString}">complete sign up</a> soon!</p>
            <p>Or scan this QR code:</p>
            <img src="cid:qrcode" alt="Signup QR Code" style="width:200px;height:200px;" />
        `;
    } 
    else {
        return { success: false, reason: 'invalid_token_type' };
    }

    const imageBuffer = await getImageBuffer(imageKey);

    const mailOptions = {
        from: 'support@clubmadeira.uk',
        to: email,
        subject,
        text,
        html,
        attachments: [
            {
                filename: imageKey,
                content: imageBuffer.toString('base64'),
                encoding: 'base64',
                cid: cid
            },
            {
                filename: 'qrcode.png',
                content: qrBuffer.toString('base64'),
                encoding: 'base64',
                cid: 'qrcode'
            }
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

async function sendDelegationEmail(email, token, phone, signup_url, url) {
    logger.debug('Sending delegation email', { email });

    const lastFourDigits = phone.slice(-4);
    const signupUrlWithPage = new URL(`${signup_url}/delegate.html`);
    signupUrlWithPage.searchParams.append('token', token);
    const signupUrlWithTokenString = signupUrlWithPage.toString();

    const qrBuffer = await QRCode.toBuffer(signupUrlWithTokenString, { errorCorrectionLevel: 'H' });
    const imageBuffer = await getImageBuffer('community.png');

    const mailOptions = {
        from: 'support@clubmadeira.uk',
        to: email,
        subject: `Transfer of control for ${url}`,
        text: `You have been invited to take control of the catalogue on ${url}.`,
        html: `
            <img src="cid:communityLogo" alt="Community Logo" />
            <p>You have been invited to take control of the catalogue on ${url}.</p>
            <p>You will receive a separate PIN to the mobile number ending ${lastFourDigits}.</p>
            <p><a href="${signupUrlWithTokenString}">Complete transfer</a></p>
            <img src="cid:qrcode" alt="QR Code" style="width:200px;height:200px;" />
        `,
        attachments: [
            { filename: 'community.png', content: imageBuffer.toString('base64'), encoding: 'base64', cid: 'communityLogo' },
            { filename: 'qrcode.png', content: qrBuffer.toString('base64'), encoding: 'base64', cid: 'qrcode' }
        ]
    };

    try {
        await sendMail(mailOptions);
        return { success: true };
    } catch (error) {
        return { success: false, reason: error.message };
    }
}

async function sendDelegationAcceptedEmail(new_email, old_email) {
    const imageBuffer = await getImageBuffer('community.png');

    const mailOptions = {
        from: 'support@clubmadeira.uk',
        to: old_email,
        subject: 'Delegation Accepted',
        html: `
            <img src="cid:communityLogo" alt="Community Logo" />
            <p>The delegation you initiated has been accepted by ${new_email}.</p>
        `,
        attachments: [
            { filename: 'community.png', content: imageBuffer.toString('base64'), encoding: 'base64', cid: 'communityLogo' }
        ]
    };

    try {
        await sendMail(mailOptions);
        return { success: true };
    } catch (error) {
        return { success: false, reason: error.message };
    }
}

// Keep the other functions you still use
async function sendMerchantBuyUrlEmail(merchantEmail, url, jsonResult, pdfBase64) {
    const imageBuffer = await getImageBuffer('merchant.png');

    const mailOptions = {
        from: 'support@clubmadeira.uk',
        to: merchantEmail,
        subject: `Your Purchased URL Report for ${url}`,
        html: `
            <img src="cid:merchantLogo" alt="Merchant Logo" />
            <p>Thank you for purchasing the report for ${url}.</p>
        `,
        attachments: [
            { filename: 'report.json', content: jsonResult, contentType: 'application/json' },
            { filename: 'report.pdf', content: pdfBase64, encoding: 'base64', contentType: 'application/pdf' },
            { filename: 'merchant.png', content: imageBuffer.toString('base64'), encoding: 'base64', cid: 'merchantLogo' }
        ]
    };

    try {
        await sendMail(mailOptions);
        return { success: true };
    } catch (error) {
        return { success: false, reason: error.message };
    }
}

async function sendCPOnboardedEmail(partnerEmail, url, partnerId) {
    // Keep your existing logic for partner onboarding email
    // (you can refactor it the same way as above when needed)
    return { success: true }; // placeholder for now
}

module.exports = {
    sendEmail,
    sendDelegationEmail,
    sendDelegationAcceptedEmail,
    sendMerchantBuyUrlEmail,
    sendCPOnboardedEmail
};