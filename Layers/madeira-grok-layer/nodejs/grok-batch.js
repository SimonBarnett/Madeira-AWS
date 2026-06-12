// nodejs/grok-batch.js
// Grok Batch API Layer - Handles xAI Batch API interactions
// Uses modern response_format + json_schema for structured output
// Updated: 08 June 2026

const { getGrokConfig, logger } = require('/opt/nodejs/helpers');
const fetch = require('node-fetch');
const FormData = require('form-data');
const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: false });

let configCache = null;

async function getConfig() {
    if (!configCache) {
        configCache = await getGrokConfig();
    }
    return configCache;
}

/**
 * Submit multiple structured requests as one xAI Batch job.
 * The caller is responsible for calculating and passing max_tokens.
 */
async function submitStructuredBatch(requests, schema, options = {}) {
    const config = await getConfig();

    const model = options.model || config.DEFAULT_MODEL || 'grok-4.3';
    const useStrict = process.env.GROK_STRICT !== 'false';

    const batchRequests = requests.map(req => ({
        custom_id: req.custom_id || `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        method: 'POST',
        url: '/v1/chat/completions',
        body: {
            model: model,
            messages: req.messages,
            temperature: options.temperature ?? config.DEFAULT_TEMPERATURE ?? 0.2,
            max_tokens: options.max_tokens ?? config.DEFAULT_MAX_TOKENS ?? 2000,
            response_format: {
                type: "json_schema",
                json_schema: {
                    name: "structured_relevance_response",
                    strict: useStrict,
                    schema: schema
                }
            }
        }
    }));

    return await submitBatch(batchRequests);
}

/**
 * Submit a batch to xAI (file upload + batch creation)
 */
async function submitBatch(batchRequests) {
    const config = await getConfig();
    const jsonl = batchRequests.map(r => JSON.stringify(r)).join('\n');

    // JSONL validation
    const lines = jsonl.split('\n');
    let invalidCount = 0;

    for (let i = 0; i < lines.length; i++) {
        try {
            JSON.parse(lines[i]);
        } catch (err) {
            invalidCount++;
            logger.error('Invalid JSONL line detected', {
                lineNumber: i + 1,
                error: err.message
            });
        }
    }

    if (invalidCount > 0) {
        throw new Error(`JSONL contains ${invalidCount} invalid lines`);
    }

    const form = new FormData();
    form.append('purpose', 'batch');
    form.append('file', Buffer.from(jsonl), {
        filename: 'batch.jsonl',
        contentType: 'application/json'
    });

    const fileRes = await fetch(
        `${config.GROK_API_URL.replace('/chat/completions', '')}/files`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.XAI_API_KEY}`,
                ...form.getHeaders()
            },
            body: form
        }
    );

    if (!fileRes.ok) {
        const err = await fileRes.text();
        throw new Error(`Failed to upload batch file: ${err}`);
    }

    const fileData = await fileRes.json();

    const batchName = `grok-batch-${Date.now()}`;

    const batchRes = await fetch(
        `${config.GROK_API_URL.replace('/chat/completions', '')}/batches`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.XAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                input_file_id: fileData.id,
                endpoint: '/v1/chat/completions',
                completion_window: '24h',
                name: batchName
            })
        }
    );

    if (!batchRes.ok) {
        const err = await batchRes.text();
        throw new Error(`Failed to create batch: ${err}`);
    }

    const batch = await batchRes.json();

    logger.info('Grok batch submitted', {
        batchId: batch.id,
        batchName,
        requestCount: batchRequests.length
    });

    return batch;
}

/**
 * Get current status of a batch from xAI
 */
async function getBatchStatus(batchId) {
    const config = await getConfig();

    const res = await fetch(
        `${config.GROK_API_URL.replace('/chat/completions', '')}/batches/${batchId}`,
        {
            headers: { 'Authorization': `Bearer ${config.XAI_API_KEY}` }
        }
    );

    if (!res.ok) {
        throw new Error(`Failed to get batch status: ${res.status}`);
    }

    return await res.json();
}

/**
 * Fetch ALL results for a completed xAI batch using the paginated results endpoint.
 */
async function getBatchResults(batchId) {
    const config = await getConfig();
    const baseUrl = config.GROK_API_URL.replace('/chat/completions', '');

    let paginationToken = null;
    const allResults = [];

    do {
        let url = `${baseUrl}/batches/${batchId}/results?limit=1000`;
        if (paginationToken) {
            url += `&pagination_token=${encodeURIComponent(paginationToken)}`;
        }

        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${config.XAI_API_KEY}` }
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Failed to fetch batch results: ${res.status} ${text}`);
        }

        const page = await res.json();

        if (page.results && Array.isArray(page.results)) {
            allResults.push(...page.results);
        }

        paginationToken = page.pagination_token || null;

    } while (paginationToken);

    logger.info('Batch results retrieved', {
        batchId,
        totalResults: allResults.length
    });

    return allResults;
}

module.exports = {
    submitStructuredBatch,
    submitBatch,
    getBatchStatus,
    getBatchResults
};