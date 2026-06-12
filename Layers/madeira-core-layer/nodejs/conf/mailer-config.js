// nodejs/conf/mailer-config.js
const { GetParametersCommand } = require('/opt/nodejs/helpers');
const { getAwsRegion, getSSMClient, createPlaceholderIfMissing } = require('/opt/nodejs/helpers');

let cache = null;
let cacheTime = 0;

async function getMailerConfig() {
    const now = Date.now();
    if (cache && (now - cacheTime < 1800000)) return cache;

    const region = await getAwsRegion();
    const client = await getSSMClient();

    const command = new GetParametersCommand({
        Names: [
            "/madeira/mailer/host",
            "/madeira/mailer/port",
            "/madeira/mailer/user",
            "/madeira/mailer/pass",
            "/madeira/mailer/bucket"
        ],
        WithDecryption: true
    });

    const response = await client.send(command);
    const existing = {};
    response.Parameters.forEach(p => {
        existing[p.Name.split('/').pop()] = p.Value;
    });

    const defaults = {
        host: "smtp.gmail.com",
        port: "587",
        user: "support@clubmadeira.uk",
        bucket: "madeira-widget-bucket"
    };

    for (const [key, value] of Object.entries(defaults)) {
        if (!existing[key]) {
            await createPlaceholderIfMissing(client, `/madeira/mailer/${key}`, value);
        }
    }
    if (!existing.pass) {
        await createPlaceholderIfMissing(client, "/madeira/mailer/pass", "CHANGE_ME");
    }

    const config = {
        EMAIL_HOST: process.env.EMAIL_HOST || existing.host,
        EMAIL_PORT: parseInt(process.env.EMAIL_PORT) || parseInt(existing.port) || 587,
        EMAIL_USER: process.env.EMAIL_USER || existing.user,
        EMAIL_PASS: process.env.EMAIL_PASS || existing.pass,
        EMAIL_BUCKET: process.env.EMAIL_BUCKET || existing.bucket
    };

    cache = config;
    cacheTime = now;
    return config;
}

module.exports = { getMailerConfig };