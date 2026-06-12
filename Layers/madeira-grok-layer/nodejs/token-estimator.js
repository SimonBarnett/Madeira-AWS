// nodejs/token-estimator.js
// Reusable token estimation using real tokenizer (@dqbd/tiktoken)
// Updated: 08 June 2026

const { get_encoding } = require('@dqbd/tiktoken');

let tokenizer = null;

function getTokenizer() {
    if (!tokenizer) {
        tokenizer = get_encoding('cl100k_base');
    }
    return tokenizer;
}

/**
 * Estimates input tokens only.
 */
function estimateInputTokens(input) {
    let messages = [];

    if (Array.isArray(input)) {
        messages = input;
    } else if (input?.messages) {
        messages = input.messages;
    } else {
        return 0;
    }

    const enc = getTokenizer();
    let tokens = 50;

    for (const msg of messages) {
        if (!msg) continue;

        if (msg.role) {
            tokens += enc.encode(msg.role).length + 4;
        }

        if (!msg.content) continue;

        const contentStr = typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content);

        tokens += enc.encode(contentStr).length;
    }

    return tokens;
}

/**
 * Estimates tokens for ONE result item based on the schema.
 * Assumes max 255 characters for all string fields.
 */
function estimateTokensPerResultItem(schema) {
    const enc = getTokenizer();

    if (!schema || schema.type !== 'object' || !schema.properties) {
        return 120; // fallback
    }

    const example = {};

    for (const [key, prop] of Object.entries(schema.properties)) {
        if (prop.type === 'string') {
            example[key] = 'x'.repeat(255);           // max 255 chars as requested
        } else if (prop.type === 'boolean') {
            example[key] = false;
        } else {
            example[key] = 'x'.repeat(50);            // fallback for other types
        }
    }

    return enc.encode(JSON.stringify(example)).length;
}

/**
 * Calculates recommended max_tokens.
 * Pass schema + expectedResults for automatic output estimation.
 */
function calculateRecommendedMaxTokens(input, options = {}) {
    const inputTokens = estimateInputTokens(input);

    let outputTokens = options.estimatedOutputTokens ?? 0;

    // Auto-calculate output tokens if schema + expectedResults are provided
    if (options.schema && typeof options.expectedResults === 'number') {
        const perItem = estimateTokensPerResultItem(options.schema);
        outputTokens = options.expectedResults * perItem;
    }

    const safetyMargin = options.safetyMargin ?? 1.25;
    const recommended = Math.ceil((inputTokens + outputTokens) * safetyMargin);

    return Math.max(recommended, options.minMaxTokens ?? 0);
}

module.exports = {
    estimateInputTokens,
    calculateRecommendedMaxTokens
};