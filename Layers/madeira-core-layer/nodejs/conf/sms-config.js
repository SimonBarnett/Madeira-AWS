// nodejs/conf/sms-config.js
const { GetParametersCommand } = require('/opt/nodejs/helpers');
const { getAwsRegion, getSSMClient, createPlaceholderIfMissing } = require('/opt/nodejs/helpers');

let cache = null;
let cacheTime = 0;

async function getSmsConfig() {
    const now = Date.now();
    if (cache && (now - cacheTime < 1800000)) return cache;

    const region = await getAwsRegion();
    const client = await getSSMClient();

    const command = new GetParametersCommand({
        Names: [
            "/madeira/sms/textmagic-username",
            "/madeira/sms/textmagic-api-key",
            "/madeira/sms/textmagic-from",
            "/madeira/sms/textmagic-url"
        ],
        WithDecryption: true
    });

    const response = await client.send(command);
    const existing = {};
    response.Parameters.forEach(p => {
        existing[p.Name.split('/').pop()] = p.Value;
    });

    const defaults = {
        "textmagic-url": "https://rest.textmagic.com/api/v2",
        "textmagic-from": "ClubMadeira"
    };

    for (const [key, value] of Object.entries(defaults)) {
        if (!existing[key]) {
            await createPlaceholderIfMissing(client, `/madeira/sms/${key}`, value);
        }
    }
    if (!existing['textmagic-username']) {
        await createPlaceholderIfMissing(client, "/madeira/sms/textmagic-username", "CHANGE_ME");
    }
    if (!existing['textmagic-api-key']) {
        await createPlaceholderIfMissing(client, "/madeira/sms/textmagic-api-key", "CHANGE_ME");
    }

    const config = {
        TEXTMAGIC_USERNAME: process.env.TEXTMAGIC_USERNAME || existing['textmagic-username'],
        TEXTMAGIC_API_KEY: process.env.TEXTMAGIC_API_KEY || existing['textmagic-api-key'],
        TEXTMAGIC_FROM: process.env.TEXTMAGIC_FROM || existing['textmagic-from'] || "ClubMadeira",
        TEXTMAGIC_URL: process.env.TEXTMAGIC_URL || existing['textmagic-url'] || "https://rest.textmagic.com/api/v2"
    };

    cache = config;
    cacheTime = now;
    return config;
}

module.exports = { getSmsConfig };