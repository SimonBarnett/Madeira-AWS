// nodejs/conf/awin-config.js
const { GetParametersCommand } = require('/opt/nodejs/helpers');
const { getAwsRegion, getSSMClient, createPlaceholderIfMissing } = require('/opt/nodejs/helpers');

let cache = null;
let cacheTime = 0;

async function getAwinConfig() {
    const now = Date.now();
    if (cache && (now - cacheTime < 1800000)) return cache;

    const region = await getAwsRegion();
    const client = await getSSMClient();

    const command = new GetParametersCommand({
        Names: [
            "/madeira/awin/access-token",
            "/madeira/awin/publisher-id"
        ],
        WithDecryption: true
    });

    const response = await client.send(command);
    const existing = {};
    response.Parameters.forEach(p => {
        existing[p.Name.split('/').pop()] = p.Value;
    });

    if (!existing['access-token']) {
        await createPlaceholderIfMissing(client, "/madeira/awin/access-token", "CHANGE_ME");
    }
    if (!existing['publisher-id']) {
        await createPlaceholderIfMissing(client, "/madeira/awin/publisher-id", "2889699");
    }

    const config = {
        AWIN_ACCESS_TOKEN: process.env.AWIN_ACCESS_TOKEN || existing['access-token'],
        AWIN_PUBLISHER_ID: process.env.AWIN_PUBLISHER_ID || existing['publisher-id']
    };

    cache = config;
    cacheTime = now;
    return config;
}

module.exports = { getAwinConfig };