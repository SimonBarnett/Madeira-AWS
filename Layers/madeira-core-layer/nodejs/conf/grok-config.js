// nodejs/conf/grok-config.js
const { GetParametersCommand } = require('/opt/nodejs/helpers');
const { getAwsRegion, getSSMClient, createPlaceholderIfMissing } = require('/opt/nodejs/helpers');

let cache = null;
let cacheTime = 0;

async function getGrokConfig() {
    const now = Date.now();
    if (cache && (now - cacheTime < 1800000)) return cache;

    const region = await getAwsRegion();
    const client = await getSSMClient();

    const command = new GetParametersCommand({
        Names: [
            "/madeira/grok/api-key",
            "/madeira/grok/api-url",
            "/madeira/grok/default-model",
            "/madeira/grok/default-temperature",
            "/madeira/grok/default-max-tokens",
            "/madeira/grok/default-top-p",
            "/madeira/grok/max-retries",
            "/madeira/grok/timeout-ms"
        ],
        WithDecryption: true
    });

    const response = await client.send(command);
    const existing = {};
    response.Parameters.forEach(p => {
        existing[p.Name.split('/').pop()] = p.Value;
    });

    const defaults = {
        "api-url": "https://api.x.ai/v1/chat/completions",
        "default-model": "grok-4",
        "default-temperature": "0.5",
        "default-max-tokens": "16000",
        "default-top-p": "0.9",
        "max-retries": "3",
        "timeout-ms": "300000"
    };

    for (const [key, value] of Object.entries(defaults)) {
        if (!existing[key]) {
            await createPlaceholderIfMissing(client, `/madeira/grok/${key}`, value);
        }
    }
    if (!existing['api-key']) {
        await createPlaceholderIfMissing(client, "/madeira/grok/api-key", "CHANGE_ME");
    }

    const config = {
        XAI_API_KEY: process.env.XAI_API_KEY || existing['api-key'],
        GROK_API_URL: process.env.GROK_API_URL || existing['api-url'] || "https://api.x.ai/v1/chat/completions",
        DEFAULT_MODEL: process.env.DEFAULT_MODEL || existing['default-model'] || 'grok-4',
        DEFAULT_TEMPERATURE: parseFloat(process.env.DEFAULT_TEMPERATURE) || parseFloat(existing['default-temperature']) || 0.5,
        DEFAULT_MAX_TOKENS: parseInt(process.env.DEFAULT_MAX_TOKENS) || parseInt(existing['default-max-tokens']) || 16000,
        DEFAULT_TOP_P: parseFloat(process.env.DEFAULT_TOP_P) || parseFloat(existing['default-top-p']) || 0.9,
        MAX_RETRIES: parseInt(process.env.MAX_RETRIES) || parseInt(existing['max-retries']) || 3,
        TIMEOUT_MS: parseInt(process.env.TIMEOUT_MS) || parseInt(existing['timeout-ms']) || 300000
    };

    cache = config;
    cacheTime = now;
    return config;
}

module.exports = { getGrokConfig };