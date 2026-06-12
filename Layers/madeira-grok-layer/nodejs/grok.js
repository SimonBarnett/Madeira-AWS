// nodejs/grok.js
// Grok structured output caller - Modern response_format + json_schema
// Streaming using proper Node.js stream handling
// Last updated: 10 June 2026

const fetch = require('node-fetch');
const Ajv = require('ajv');
const { getGrokConfig, logger } = require('/opt/nodejs/helpers');

const ajv = new Ajv({ allErrors: true, strict: false });

async function callGrokStructured(messages, schema, options = {}) {
    const transactionId = `grok-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    let attempt = 0;

    const config = await getGrokConfig();

    const {
        model = config.DEFAULT_MODEL || 'grok-4.3',
        temperature = config.DEFAULT_TEMPERATURE ?? 0.2,
        max_tokens = config.DEFAULT_MAX_TOKENS ?? 2000,
        top_p = config.DEFAULT_TOP_P ?? 1
    } = options;

    // Handle array schema wrapping
    let responseSchema = schema;
    const isArraySchema = schema && schema.type === 'array';

    if (isArraySchema) {
        responseSchema = {
            type: 'object',
            properties: { data: schema },
            required: ['data'],
            additionalProperties: false
        };
    }

    while (attempt < config.MAX_RETRIES) {
        attempt++;

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), config.TIMEOUT_MS || 60000);

            const payload = {
                model,
                messages,
                temperature,
                max_tokens,
                top_p,
                stream: true,

                response_format: {
                    type: "json_schema",
                    json_schema: {
                        name: "structured_response",
                        strict: true,
                        schema: responseSchema
                    }
                }
            };

            const response = await fetch(config.GROK_API_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.XAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Grok API error ${response.status}: ${errorText}`);
            }

            // ====================== PROPER NODE.JS STREAM HANDLING ======================
            let buffer = '';
            let fullContent = '';

            // Use for-await-of on the Node.js Readable stream
            for await (const chunk of response.body) {
                buffer += chunk.toString();

                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data: ')) continue;

                    const dataStr = trimmed.slice(6).trim();
                    if (dataStr === '[DONE]') break;

                    try {
                        const data = JSON.parse(dataStr);
                        const deltaContent = data.choices?.[0]?.delta?.content;
                        if (deltaContent) {
                            fullContent += deltaContent;
                        }
                    } catch (e) {
                        // Ignore malformed chunks
                    }
                }
            }

            if (!fullContent) {
                throw new Error('No structured content received from Grok');
            }

            let parsed = JSON.parse(fullContent);

            // Unwrap if array schema was used
            if (isArraySchema && parsed.data !== undefined) {
                parsed = parsed.data;
            }

            // Schema validation
            if (schema) {
                const validate = ajv.compile(schema);
                if (!validate(parsed)) {
                    logger.warn('Grok response failed schema validation', {
                        transactionId,
                        errors: validate.errors
                    });
                    if (attempt === config.MAX_RETRIES) {
                        throw new Error('Schema validation failed after max retries');
                    }
                    continue;
                }
            }

            logger.debug('✅ Grok structured response received', { transactionId });
            return parsed;

        } catch (error) {
            logger.error(`[Grok] Attempt ${attempt} failed`, {
                transactionId,
                error: error.message
            });

            if (attempt === config.MAX_RETRIES) throw error;

            await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
}

module.exports = { callGrokStructured };