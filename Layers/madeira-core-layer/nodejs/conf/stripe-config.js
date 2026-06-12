// nodejs/conf/stripe-config.js
const { GetParametersCommand } = require('/opt/nodejs/helpers');
const { getAwsRegion, getSSMClient, createPlaceholderIfMissing, logger } = require('/opt/nodejs/helpers');

let cache = null;
let cacheTime = 0;

async function getStripeConfig() {
    const now = Date.now();
    if (cache && (now - cacheTime < 1800000)) return cache;

    const region = await getAwsRegion();
    const client = await getSSMClient();

    const command = new GetParametersCommand({
        Names: [
            "/madeira/stripe/secret-key", 
            "/madeira/stripe/test-secret-key",
            "/madeira/stripe/platform-account-id",
            "/madeira/stripe/platform-customer-id", 
            "/madeira/stripe/platform-customer-id-test",
            "/madeira/stripe/platform-payment-method", 
            "/madeira/stripe/platform-payment-method-test",
            "/madeira/stripe/vat-tax-rate-id", 
            "/madeira/stripe/vat-tax-rate-id-test"
        ],
        WithDecryption: true
    });

    const response = await client.send(command);
    const existing = {};
    response.Parameters.forEach(p => {
        existing[p.Name.split('/').pop()] = p.Value;
    });

    if (!existing['secret-key']) await createPlaceholderIfMissing(client, "/madeira/stripe/secret-key", "CHANGE_ME");
    if (!existing['test-secret-key']) await createPlaceholderIfMissing(client, "/madeira/stripe/test-secret-key", "CHANGE_ME");
    if (!existing['platform-account-id']) await createPlaceholderIfMissing(client, "/madeira/stripe/platform-account-id", "acct_XXXXXXXXXXXXXXXX");
    if (!existing['platform-customer-id']) await createPlaceholderIfMissing(client, "/madeira/stripe/platform-customer-id", "cus_XXXXXXXXXXXXXXXX");
    if (!existing['platform-customer-id-test']) await createPlaceholderIfMissing(client, "/madeira/stripe/platform-customer-id-test", "cus_test_XXXXXXXXXXXXXXXX");
    if (!existing['platform-payment-method']) await createPlaceholderIfMissing(client, "/madeira/stripe/platform-payment-method", "pm_card_visa");
    if (!existing['platform-payment-method-test']) await createPlaceholderIfMissing(client, "/madeira/stripe/platform-payment-method-test", "pm_card_visa");
    if (!existing['vat-tax-rate-id']) await createPlaceholderIfMissing(client, "/madeira/stripe/vat-tax-rate-id", "txr_XXXXXXXXXXXXXXXX");
    if (!existing['vat-tax-rate-id-test']) await createPlaceholderIfMissing(client, "/madeira/stripe/vat-tax-rate-id-test", "txr_test_XXXXXXXXXXXXXXXX");

    const config = {
        STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || existing['secret-key'],
        STRIPE_TEST_SECRET_KEY: process.env.STRIPE_TEST_SECRET_KEY || existing['test-secret-key'],
        PLATFORM_ACCOUNT_ID: process.env.PLATFORM_ACCOUNT_ID || existing['platform-account-id'],
        PLATFORM_CUSTOMER_ID: process.env.PLATFORM_CUSTOMER_ID || existing['platform-customer-id'],
        PLATFORM_CUSTOMER_ID_TEST: process.env.PLATFORM_CUSTOMER_ID_TEST || existing['platform-customer-id-test'],
        PLATFORM_PAYMENT_METHOD: process.env.PLATFORM_PAYMENT_METHOD || existing['platform-payment-method'],
        PLATFORM_PAYMENT_METHOD_TEST: process.env.PLATFORM_PAYMENT_METHOD_TEST || existing['platform-payment-method-test'],
        VAT_TAX_RATE_ID: process.env.VAT_TAX_RATE_ID || existing['vat-tax-rate-id'],
        VAT_TAX_RATE_ID_TEST: process.env.VAT_TAX_RATE_ID_TEST || existing['vat-tax-rate-id-test']
    };

    cache = config;
    cacheTime = now;
    return config;
}

module.exports = { getStripeConfig };