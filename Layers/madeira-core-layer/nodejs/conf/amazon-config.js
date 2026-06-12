// nodejs/conf/amazon-config.js
const { GetParametersCommand } = require('/opt/nodejs/helpers');
const { getAwsRegion, getSSMClient, createPlaceholderIfMissing } = require('/opt/nodejs/helpers');

let cache = null;
let cacheTime = 0;

async function getAmazonConfig() {
    const now = Date.now();
    if (cache && (now - cacheTime < 1800000)) return cache;

    const region = await getAwsRegion();
    const client = await getSSMClient();

    const command = new GetParametersCommand({
        Names: [
            "/madeira/amazon/access-key",
            "/madeira/amazon/secret-key",
            "/madeira/amazon/associate-tag",
            "/madeira/amazon/host",
            "/madeira/amazon/region"
        ],
        WithDecryption: true
    });

    const response = await client.send(command);
    const existing = {};
    response.Parameters.forEach(p => {
        existing[p.Name.split('/').pop()] = p.Value;
    });

    if (!existing['access-key']) await createPlaceholderIfMissing(client, "/madeira/amazon/access-key", "CHANGE_ME");
    if (!existing['secret-key']) await createPlaceholderIfMissing(client, "/madeira/amazon/secret-key", "CHANGE_ME");
    if (!existing['associate-tag']) await createPlaceholderIfMissing(client, "/madeira/amazon/associate-tag", "mymodelflying-21");
    if (!existing['host']) await createPlaceholderIfMissing(client, "/madeira/amazon/host", "webservices.amazon.co.uk");
    if (!existing['region']) await createPlaceholderIfMissing(client, "/madeira/amazon/region", "eu-west-1");

    const config = {
        AMAZON_ACCESS_KEY: process.env.AMAZON_ACCESS_KEY || existing['access-key'],
        AMAZON_SECRET_KEY: process.env.AMAZON_SECRET_KEY || existing['secret-key'],
        AMAZON_ASSOCIATE_TAG: process.env.AMAZON_ASSOCIATE_TAG || existing['associate-tag'],
        AMAZON_HOST: process.env.AMAZON_HOST || existing['host'],
        AMAZON_REGION: process.env.AMAZON_REGION || existing['region']
    };

    cache = config;
    cacheTime = now;
    return config;
}

module.exports = { getAmazonConfig };