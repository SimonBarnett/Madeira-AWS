// test-lambda/index.js
// Madeira Layers Unit Test Lambda - Designed for JSON Test Events in Console

const { 
    logger, 
    getAwsRegion,
    hashPassword,
    comparePassword,
    enqueueMessage 
} = require('/opt/nodejs/helpers');           // Core layer

const { 
    generateUserId, 
    validateUserId, 
    signJWT, 
    verifyJWT 
} = require('/opt/nodejs/jwt');               // Auth layer

const { callGrokStructured } = require('/opt/nodejs/grok');           // Grok layer

const { getStripeClient } = require('/opt/nodejs/stripe');            // Payments layer
const { sendMail } = require('/opt/nodejs/mailer');                   // Payments layer

exports.handler = async (event) => {
    const testCase = event.test || event.route || 'health';
    logger.debug('Test Lambda started', { testCase });

    try {
        switch (testCase) {

            case 'health':
                return { status: 'ok', message: 'All layers loaded successfully', timestamp: new Date().toISOString() };

            case 'core-region':
                const region = await getAwsRegion();
                return { success: true, test: 'core-region', region };

            case 'core-sqs':
                await enqueueMessage({ type: 'test', message: 'Unit test from console', test: true });
                return { success: true, test: 'core-sqs', message: 'Message sent to SQS' };

            case 'auth-userid':
                const userId = generateUserId();
                const isValid = validateUserId(userId);
                return { success: true, test: 'auth-userid', userId, isValid };

            case 'auth-jwt':
                const payload = { user_id: "TEST-UNIT-123", role: "tester" };
                const token = await signJWT(payload, { expiresIn: '5m' });
                const decoded = await verifyJWT(token);
                return { 
                    success: true, 
                    test: 'auth-jwt', 
                    tokenPreview: token.substring(0, 40) + '...',
                    decoded 
                };

            case 'auth-password':
                const password = "TestPassword123!";
                const hash = await hashPassword(password);
                const match = await comparePassword(password, hash);
                return { success: true, test: 'auth-password', hashPreview: hash.substring(0, 20) + '...', match };

            case 'grok':
                const messages = [{ role: "user", content: "What is the capital of France?" }];
                const schema = {
                    type: "object",
                    properties: { answer: { type: "string" }, confidence: { type: "number" } },
                    required: ["answer"]
                };
                const result = await callGrokStructured(messages, schema, { stream: false });
                return { success: true, test: 'grok', result };

            case 'payments-stripe':
                const stripe = await getStripeClient({});
                return { 
                    success: true, 
                    test: 'payments-stripe', 
                    isSandbox: stripe.isSandbox,
                    hasPlatformAccount: !!stripe.platformAccountId 
                };

            case 'payments-mailer':
                const mailConfig = await require('/opt/nodejs/mailer-config').getMailerConfig();
                return { 
                    success: true, 
                    test: 'payments-mailer', 
                    emailHost: mailConfig.EMAIL_HOST,
                    bucket: mailConfig.EMAIL_BUCKET 
                };

            default:
                return { 
                    error: "Unknown test case", 
                    availableTests: [
                        "health", "core-region", "core-sqs", "auth-userid", 
                        "auth-jwt", "auth-password", "grok", 
                        "payments-stripe", "payments-mailer"
                    ]
                };
        }
    } catch (error) {
        logger.error('Test failed', { testCase, error: error.message });
        return { error: error.message, test: testCase };
    }
};

logger.debug('✅ Test Lambda (index.js) ready for console JSON test events');