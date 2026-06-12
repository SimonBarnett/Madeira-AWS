// nodejs/conf/ebay-config.js
const { GetParametersCommand } = require('/opt/nodejs/helpers');
const { getAwsRegion, getSSMClient, createPlaceholderIfMissing } = require('/opt/nodejs/helpers');

let cache = null;
let cacheTime = 0;

async function getEbayConfig() {
    const now = Date.now();
    if (cache && (now - cacheTime < 1800000)) return cache;

    const region = await getAwsRegion();
    const client = await getSSMClient();

    const command = new GetParametersCommand({
        Names: [
            "/madeira/ebay/campaign-id",
            "/madeira/ebay/client-id",
            "/madeira/ebay/client-secret",
            "/madeira/ebay/marketplace-id"
        ],
        WithDecryption: true
    });

    const response = await client.send(command);
    const existing = {};
    response.Parameters.forEach(p => {
        existing[p.Name.split('/').pop()] = p.Value;
    });

    if (!existing['campaign-id']) await createPlaceholderIfMissing(client, "/madeira/ebay/campaign-id", "5339112836");
    if (!existing['client-id']) await createPlaceholderIfMissing(client, "/madeira/ebay/client-id", "CHANGE_ME");
    if (!existing['client-secret']) await createPlaceholderIfMissing(client, "/madeira/ebay/client-secret", "CHANGE_ME");
    if (!existing['marketplace-id']) await createPlaceholderIfMissing(client, "/madeira/ebay/marketplace-id", "EBAY_GB");

    const config = {
        EBAY_CAMPAIGN_ID: process.env.EBAY_CAMPAIGN_ID || existing['campaign-id'],
        EBAY_CLIENT_ID: process.env.EBAY_CLIENT_ID || existing['client-id'],
        EBAY_CLIENT_SECRET: process.env.EBAY_CLIENT_SECRET || existing['client-secret'],
        EBAY_MARKETPLACE_ID: process.env.EBAY_MARKETPLACE_ID || existing['marketplace-id']
    };

    cache = config;
    cacheTime = now;
    return config;
}

module.exports = { getEbayConfig };