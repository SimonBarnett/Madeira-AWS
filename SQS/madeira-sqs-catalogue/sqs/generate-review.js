// ====================== sqs/clubscan/generate-review.js ======================
// Uses Grok's browsing tool to fully scan the website
// Generates structured review + market segments
// Saves JsonResult directly to clubscan table
// Then enqueues CLUBSCAN_GENERATE_CATEGORIES (unless in sandbox)
// Automatically records errors in LastError on failure
// Last updated: 11 June 2026

const {
    logger,
    enqueueMessage,
    sql
} = require('/opt/nodejs/helpers');

const { callGrokStructured } = require('/opt/nodejs/grok');
const { withStatusHandling } = require('./helpers');
const { RESPONSE_SCHEMA } = require('../grok_schema');


// ====================== GENERATE STRUCTURED REVIEW ======================
async function generateStructuredReview(url) {
    const messages = [
        {
            role: 'system',
            content: `You are a precise data extraction specialist.

You have access to a web browsing tool. You MUST use it to thoroughly scan the website, including the homepage, About page, Contact page, and any footer information.

EXTRACTION RULES (follow these strictly):

1. name: Extract the FULL official name of the club exactly as it appears on the website. Do NOT shorten it, rebrand it, or use a generic version.

2. location: 
   - First priority: Extract the specific town, city or region the club operates in (e.g. "Portsmouth & Fareham", "Hampshire", "Manchester").
   - Only use "National" or "United Kingdom" if the club clearly states it operates across the whole UK with no local base.
   - Never default to "National" or "United Kingdom" just because it's a UK website.

3. sector: Identify the main focus/sector of the club based on its content.

4. audience: Describe who the website is aimed at based on the content.

5. email: Extract a contact email address ONLY if it is clearly displayed on the website. Leave blank if none is found.

6. review & marketSegments: After extracting the above, analyse the club for affiliate opportunities.

Be accurate and conservative. If something is not clearly stated on the website, do not guess.`
        },
        {
            role: 'user',
            content: `Please browse this website thoroughly and extract the required fields accurately: ${url}`
        }
    ];

    const result = await callGrokStructured(messages, RESPONSE_SCHEMA, {
        temperature: 0.4,
        max_tokens: 8000
    });

    if (!result?.review) {
        logger.warn('Grok returned weak review', { url });
        return {
            review: "Grok was unable to generate a useful review for this website.",
            marketSegments: []
        };
    }

    return result;
}

// ====================== HANDLER ======================
async function handle(event) {
    const { sandbox } = event;

    return withStatusHandling(event, async ({ pool, url }) => {

        // Grok uses its own tool to browse and analyse the full website
        const structured = await generateStructuredReview(url);

        // Save result to database
        await pool.request()
            .input('url', sql.NVarChar, url)
            .input('jsonResult', sql.NVarChar(sql.MAX), JSON.stringify(structured))
            .query(`
                UPDATE clubscan 
                SET JsonResult = @jsonResult, UpdatedAt = GETDATE() 
                WHERE Url = @url
            `);

        // Enqueue next step (skip in sandbox)
        if (!sandbox) {
            await enqueueMessage({ 
                type: 'CLUBSCAN_GENERATE_CATEGORIES', 
                url 
            });
            logger.info('✅ Review complete → Enqueued CLUBSCAN_GENERATE_CATEGORIES', { url });
        } else {
            logger.info('Sandbox mode enabled - skipping enqueue of CLUBSCAN_GENERATE_CATEGORIES', { url });
        }

    }, {
        startStatus: 'reviewing',
        successStatus: 'review_complete'
    });
}

module.exports = { handle };