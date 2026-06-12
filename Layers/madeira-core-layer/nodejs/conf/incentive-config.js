// nodejs/conf/incentive-config.js
const { GetParametersCommand } = require('/opt/nodejs/helpers');
const { getAwsRegion, getSSMClient, createPlaceholderIfMissing } = require('/opt/nodejs/helpers');

let cache = null;
let cacheTime = 0;

async function getIncentiveConfig() {
    const now = Date.now();
    if (cache && (now - cacheTime < 1800000)) return cache; // 30 min cache

    const region = await getAwsRegion();
    const client = await getSSMClient();

    const command = new GetParametersCommand({
        Names: [
            "/madeira/incentive/access-key-id",
            "/madeira/incentive/secret-access-key",
            "/madeira/incentive/brand",
            "/madeira/incentive/currency",
            "/madeira/incentive/partner-id",
            "/madeira/incentive/sandbox"
        ],
        WithDecryption: true
    });

    const response = await client.send(command);
    const existing = {};
    response.Parameters.forEach(p => {
        existing[p.Name.split('/').pop()] = p.Value;
    });

    // Create placeholders for any missing parameters (self-healing)
    if (!existing['access-key-id']) {
        await createPlaceholderIfMissing(client, "/madeira/incentive/access-key-id", "CHANGE_ME");
    }
    if (!existing['secret-access-key']) {
        await createPlaceholderIfMissing(client, "/madeira/incentive/secret-access-key", "CHANGE_ME");
    }
    if (!existing['brand']) {
        await createPlaceholderIfMissing(client, "/madeira/incentive/brand", "Club Madeira");
    }
    if (!existing['currency']) {
        await createPlaceholderIfMissing(client, "/madeira/incentive/currency", "GBP");
    }
    if (!existing['partner-id']) {
        await createPlaceholderIfMissing(client, "/madeira/incentive/partner-id", "CHANGE_ME");
    }
    if (!existing['sandbox']) {
        await createPlaceholderIfMissing(client, "/madeira/incentive/sandbox", "true");
    }

    const config = {
        AMAZON_ACCESS_KEY_ID: process.env.AMAZON_ACCESS_KEY_ID || existing['access-key-id'],
        AMAZON_SECRET_ACCESS_KEY: process.env.AMAZON_SECRET_ACCESS_KEY || existing['secret-access-key'],
        AMAZON_BRAND: process.env.AMAZON_BRAND || existing['brand'] || 'Club Madeira',
        AMAZON_CURRENCY: process.env.AMAZON_CURRENCY || existing['currency'] || 'GBP',
        AMAZON_PARTNER_ID: process.env.AMAZON_PARTNER_ID || existing['partner-id'],
        AMAZON_SANDBOX: process.env.AMAZON_SANDBOX || existing['sandbox'] || 'true'
    };

    cache = config;
    cacheTime = now;
    return config;
}

module.exports = { getIncentiveConfig };