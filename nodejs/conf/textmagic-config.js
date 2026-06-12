// nodejs/conf/textmagic-config.js
// Centralized TextMagic configuration from SSM Parameter Store

const { GetParametersCommand } = require('/opt/nodejs/helpers');
const { getAwsRegion, getSSMClient, createPlaceholderIfMissing } = require('/opt/nodejs/helpers');

let cache = null;
let cacheTime = 0;

const DEFAULT_URL = 'https://rest.textmagic.com/api/v2/messages';

async function getTextMagicConfig() {
    const now = Date.now();
    if (cache && (now - cacheTime < 1800000)) return cache; // 30 min cache

    const region = await getAwsRegion();
    const client = await getSSMClient();

    const command = new GetParametersCommand({
        Names: [
            '/madeira/textmagic/url',
            '/madeira/textmagic/username',
            '/madeira/textmagic/api-key'
        ],
        WithDecryption: true
    });

    const response = await client.send(command);
    const existing = {};
    response.Parameters.forEach(p => {
        existing[p.Name.split('/').pop().replace('-', '_')] = p.Value;
    });

    // Self-healing placeholders
    if (!existing['url']) {
        await createPlaceholderIfMissing(client, '/madeira/textmagic/url', DEFAULT_URL);
    }
    if (!existing['username']) {
        await createPlaceholderIfMissing(client, '/madeira/textmagic/username', 'CHANGE_ME');
    }
    if (!existing['api_key']) {
        await createPlaceholderIfMissing(client, '/madeira/textmagic/api-key', 'CHANGE_ME');
    }

    const config = {
        TEXTMAGIC_URL: existing['url'] || DEFAULT_URL,
        TEXTMAGIC_USERNAME: existing['username'],
        TEXTMAGIC_API_KEY: existing['api_key']
    };

    cache = config;
    cacheTime = now;
    return config;
}

module.exports = { getTextMagicConfig };