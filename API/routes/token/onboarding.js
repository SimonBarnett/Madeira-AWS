// API/routes/token/onboarding.js
// Consolidated single file for all onboarding concerns
// actions: 'generate' | 'validate' | 'complete' | 'complete-signup'

const { logger, sql, getStripeClient, enqueueMessage } = require('/opt/nodejs/helpers');
const { signJWT, verifyJWT } = require('/opt/nodejs/jwt');
const { sendEmail, sendCPOnboardedEmail } = require('./email');
const { sendSmsTextmagic } = require('/opt/nodejs/sms');

const {
    generatePin, normalizePhone, isValidPhone, isValidEmail,
    getUserById, isUserIdUnique, createUser, capturePostHogEvent,
    confirmOnboarding, buildSetTokenUrl, setLastLogin,
    originCode, getTrafficAv
} = require('./helpers');

const { generateUserId } = require('/opt/nodejs/auth-utils');

module.exports = async (event, { action, pool, sandbox = false }) => {
    const body = event.body ? JSON.parse(event.body) : {};
    const query = event.queryStringParameters || {};

    // ========== generate ==========
    if (action === 'generate') {
        // ... (existing generate logic - kept short for this response)
        if (sandbox) logger.debug('[SANDBOX] Onboarding token generated');
        return { statusCode: 200, body: { status: 'success', message: 'Onboarding token generated successfully' } };
    }

    // ========== validate ==========
    if (action === 'validate') {
        // ... (existing validate logic)
        return { statusCode: 200, body: { status: 'success', account_link: 'https://...' } };
    }

    // ========== complete (FULL EXPANDED LOGIC) ==========
    if (action === 'complete') {
        const queryToken = query.token;
        if (!queryToken) {
            return { statusCode: 400, body: { status: 'error', error_message: 'Token is required' } };
        }

        if (sandbox) logger.debug('[SANDBOX] Starting complete onboarding', { token: queryToken });

        // Get onboarding data using passed pool
        const onboardingDataResult = await pool.request()
            .input('token_id', sql.VarChar, queryToken)
            .query('SELECT * FROM Tokens WHERE token_id = @token_id');

        const onboardingData = onboardingDataResult.recordset[0];
        if (!onboardingData) {
            return { statusCode: 400, body: { status: 'error', error_message: 'Invalid token' } };
        }

        // Basic validation
        const issuedAt = new Date(onboardingData.issued_at);
        if (Date.now() > issuedAt.getTime() + (48 * 60 * 60 * 1000)) {
            return { statusCode: 400, body: { status: 'error', error_message: 'Token expired' } };
        }

        const role = onboardingData.tokenType;
        const signupUrl = onboardingData.signup_url;
        const stripeAccountId = onboardingData.stripe_account_id;

        event.headers = event.headers || {};
        event.headers.origin = signupUrl;

        let stripe;
        try {
            stripe = await getStripeClient(event);
        } catch (error) {
            logger.error('Failed to initialize Stripe client', { error: error.message });
            return { statusCode: 500, body: { status: 'error', error_message: 'Failed to initialize Stripe' } };
        }

        let stripeAccount;
        try {
            stripeAccount = await stripe.accounts.retrieve(stripeAccountId);
        } catch (error) {
            logger.error('Failed to retrieve Stripe account', { stripeAccountId, error: error.message });
            return { statusCode: 500, body: { status: 'error', error_message: 'Failed to retrieve Stripe account' } };
        }

        // Generate unique User ID
        let userId;
        let attempts = 0;
        const maxAttempts = 25;
        do {
            userId = generateUserId();
            attempts++;
        } while (!(await isUserIdUnique(userId)) && attempts < maxAttempts);

        if (attempts >= maxAttempts) {
            return { statusCode: 500, body: { status: 'error', error_message: 'Failed to generate unique user ID' } };
        }

        const isSandboxStripe = stripe.isSandbox; // Stripe's own sandbox flag
        const logEmail = stripeAccount.email || onboardingData.email;
        const logPhone = stripeAccount.phone || onboardingData.phone;

        const userData = {
            user_id: userId,
            email_address: logEmail,
            permissions: [role],
            stripe_account_id: stripeAccountId,
            role,
            referrer: onboardingData.referrer_by,
            phone_number: logPhone
        };

        if (role === 'community') {
            const individual = stripeAccount.individual || {};
            userData.first_name = individual.first_name || null;
            userData.last_name = individual.last_name || null;
            userData.dob = individual.dob ? JSON.stringify(individual.dob) : null;
            userData.address = individual.address || null;
            userData.ssn_last_4 = individual.ssn_last_4 || null;
        } else if (role === 'merchant' || role === 'partner') {
            const company = stripeAccount.company || {};
            userData.company_name = company.name || null;
            userData.tax_id = company.tax_id || null;
            userData.address = company.address || null;
        }

        if (role === 'community' && !userData.first_name && logEmail) {
            userData.first_name = logEmail.split('@')[0];
        }
        if (role === 'merchant' && !userData.company_name && logEmail) {
            userData.company_name = logEmail.split('@')[0];
        }

        await createUser(userData);
        logger.info('User created from onboarding', { userId, role, email: logEmail });

        if (role === 'partner' && onboardingData.url) {
            await pool.request()
                .input('user_id', sql.VarChar, userId)
                .input('signupurl', sql.VarChar, onboardingData.url)
                .query('UPDATE Users SET signupurl = @signupurl WHERE user_id = @user_id');
        }

        await capturePostHogEvent(userId, 'signup', {
            user_id: userId,
            role,
            affiliate_code: onboardingData.referrer_by
        });

        // Start ClubScan pipeline for communities
        if (role === 'community' && onboardingData.url) {
            try {
                await pool.request()
                    .input('url', sql.NVarChar, onboardingData.url)
                    .input('clubId', sql.VarChar, userId)
                    .input('partnerId', sql.VarChar, onboardingData.referrer_by || null)
                    .input('status', sql.VarChar, 'queued')
                    .query(`
                        MERGE INTO clubscan AS target
                        USING (SELECT @url AS Url) AS source
                        ON target.Url = source.Url
                        WHEN NOT MATCHED THEN
                            INSERT (Url, ClubID, PartnerId, Status, CreatedAt, UpdatedAt)
                            VALUES (@url, @clubId, @partnerId, @status, GETDATE(), GETDATE());
                    `);

                await enqueueMessage({
                    type: 'CLUBSCAN_FETCH_CONTENT',
                    url: onboardingData.url
                });

                logger.info('ClubScan pipeline started via SQS', { userId, url: onboardingData.url });
            } catch (err) {
                logger.error('Failed to start ClubScan pipeline', { userId, url: onboardingData.url, error: err.message });
            }
        }

        if (role === 'partner' && onboardingData.url) {
            await sendCPOnboardedEmail(logEmail, onboardingData.url, userId);
        }

        if (role === 'merchant') {
            const paymentResult = await confirmOnboarding(userId, onboardingData.referrer_by, event);
            if (paymentResult.statusCode !== 200) {
                return { statusCode: paymentResult.statusCode, body: { status: 'error', error_message: 'Payment failed' } };
            }
        }

        const token = await signJWT({
            user_id: userId,
            permissions: [role],
            exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60)
        });

        await setLastLogin(userId, event.requestContext?.identity?.sourceIp);

        const contactName = userData.company_name || userData.first_name || userId;
        const decodedSignupUrl = new URL(signupUrl).href;

        const redirectUrl = buildSetTokenUrl(
            decodedSignupUrl,
            token,
            userId,
            contactName,
            'signup',
            isSandboxStripe,
            'This is your first login.'
        );

        // Delete used token using passed pool
        await pool.request()
            .input('token_id', sql.VarChar, queryToken)
            .query('DELETE FROM Tokens WHERE token_id = @token_id');

        if (sandbox) logger.debug('[SANDBOX] Onboarding complete - redirecting', { userId, role });

        return {
            statusCode: 302,
            headers: { Location: redirectUrl },
            body: ''
        };
    }

    // ========== complete-signup ==========
    if (action === 'complete-signup') {
        if (sandbox) logger.debug('[SANDBOX] complete-signup called');
        return { statusCode: 200, body: { status: 'success', token: body.authToken || '', user_id: '', contact_name: '', workflow: 'login' } };
    }

    return { statusCode: 400, body: { status: 'error', error_message: 'Invalid action' } };
};