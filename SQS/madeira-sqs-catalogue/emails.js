// ====================== sqs/clubscan/emails.js ======================
// Success / Failure email helpers for Clubscan
// Uses the shared mailer from the central layer (/opt/nodejs/mailer)
// Failure emails now accept recipients (driven by SANDBOX_NOTIFY from helpers.js)
// Last updated: 11 June 2026

const { sendMail } = require('/opt/nodejs/mailer');
const { logger } = require('/opt/nodejs/helpers');

// ====================== SUCCESS EMAIL ======================
async function sendSuccessEmail(toEmails, clubId, url) {
    // Normalise to array
    let recipients = toEmails;
    if (typeof recipients === 'string') {
        recipients = recipients.split(',').map(e => e.trim()).filter(Boolean);
    }

    if (!Array.isArray(recipients) || recipients.length === 0) {
        logger.warn('No valid emails to send success email to', { url });
        return { success: false };
    }

    const widgetCode = `<div id="madeira-container"></div><script data-affiliate="${clubId}" data-css="madeira-widget.css" src="https://madeira-widget-bucket.s3.eu-west-2.amazonaws.com/madeira-widget.js?v=1.0"></script>`;
    const escapedWidgetCode = widgetCode.replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

// ====================== FAILURE EMAIL ======================
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

module.exports = {
    sendSuccessEmail,
    sendFailureEmail
};