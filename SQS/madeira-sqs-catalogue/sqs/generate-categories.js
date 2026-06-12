// ====================== sqs/generate-categories.js ======================
// Generates discount categories using Grok (structured output)
// Fetches full club record from clubscan table using url
// Saves to UserCategories and enqueues CLUBSCAN_BUILD_CATALOG (unless in sandbox)
// Explicitly tells build-catalog to trigger CLUBSCAN_NOTIFY afterwards
// Automatically records errors in LastError on failure
// Last updated: 11 June 2026

const {
    logger,
    enqueueMessage,
    sql
} = require('/opt/nodejs/helpers');

const { callGrokStructured } = require('/opt/nodejs/grok');
const { CATEGORY_SCHEMA } = require('../grok_schema');
const { withStatusHandling } = require('./helpers');

// ====================== HANDLER ======================
async function handle(event) {
    const { sandbox } = event;

    return withStatusHandling(event, async ({ pool, url }) => {

        // Fetch club record using the shared pool
        const clubResult = await pool.request()
            .input('url', sql.NVarChar, url)
            .query('SELECT * FROM clubscan WHERE Url = @url');

        const clubRecord = clubResult.recordset[0];

        if (!clubRecord) {
            throw new Error('Club record not found in clubscan');
        }

        // Generate rich categories using Grok
        const categories = await generateCategories(clubRecord);

        // Save to UserCategories using the shared pool
        await pool.request()
            .input('uid', sql.VarChar, clubRecord.ClubID)
            .input('json_categories', sql.NVarChar, JSON.stringify(categories))
            .input('json_chat', sql.NVarChar, JSON.stringify([{ prompt: 'Generate categories from club record' }]))
            .query(`
                MERGE INTO UserCategories AS target
                USING (SELECT @uid AS uid) AS source
                ON target.uid = source.uid
                WHEN MATCHED THEN 
                    UPDATE SET 
                        json_categories = @json_categories, 
                        json_chat = @json_chat, 
                        LastUpdate = GETDATE()
                WHEN NOT MATCHED THEN 
                    INSERT (uid, json_categories, json_chat, LastUpdate) 
                    VALUES (@uid, @json_categories, @json_chat, GETDATE());
            `);

        logger.info('Categories saved to UserCategories', {
            userId: clubRecord.ClubID,
            url
        });

        // Enqueue next step (skip in sandbox)
        if (!sandbox) {
            await enqueueMessage({
                type: 'CLUBSCAN_BUILD_CATALOG',
                url,
                sandbox,
                enqueueNotify: true
            });
            logger.info('✅ Categories generated and CLUBSCAN_BUILD_CATALOG enqueued (with notify)', { url });
        } else {
            logger.info('Sandbox mode enabled - skipping enqueue of CLUBSCAN_BUILD_CATALOG', { url });
        }

    }, {
        startStatus: 'generating_categories',
        successStatus: 'categories_complete'
    });
}

// ====================== GENERATE CATEGORIES ======================
async function generateCategories(clubRecord) {
    let parsed = {};

    if (clubRecord.JsonResult) {
        try {
            parsed = JSON.parse(clubRecord.JsonResult);
        } catch (e) {
            logger.warn('Failed to parse JsonResult', { 
                url: clubRecord.Url, 
                error: e.message 
            });
        }
    }

    const clubName       = parsed.name || 'Unknown Club';
    const location       = parsed.location || '';
    const sector         = parsed.sector || '';
    const audience       = parsed.audience || '';
    const reviewText     = parsed.review || '';
    const marketSegments = parsed.marketSegments || [];

    const context = {
        clubName,
        url: clubRecord.Url,
        location,
        sector,
        audience,
        review: reviewText,
        marketSegments: marketSegments.map(m => ({
            segmentName: m.segmentName,
            description: m.description
        }))
    };

    const systemContent = 
        `You are an expert UK affiliate marketing strategist for sports, leisure and community clubs.

Use the provided Club Information (especially review, sector, audience and marketSegments) to generate relevant categories.

CRITICAL RULES - FOLLOW THESE STRICTLY:

1. EVERY category MUST have a valid FREE FontAwesome icon (fa-solid, fa-regular or fa-brands only).

2. You must assign ordering based on relevance to the club's audience:
   - MainCategoryOrder: Rank each main category by relevance (1 = most relevant).
   - SubCategoryOrder: Within each category, rank subcategories by relevance (1 = most relevant).

3. Each category must follow this structure:

{
  "icon": "fa-solid fa-xxx",
  "MainCategoryOrder": 1,
  "subcategories": [ ... ]
}

4. Each subcategory must follow this structure:

{
  "name": "Subcategory Name",
  "SubCategoryOrder": 1,
  "searchTerms": [
    "*most*specific*3*word*term*",
    "*slightly*wider*term*",
    "*even*wider*term*",
    "*broad*term*",
    "*widest*term*"
  ],
  "meta": {
    "relevantKeywords": ["keyword1", "keyword2"],
    "irrelevantKeywords": ["avoid1", "avoid2"],
    "notes": "Short guidance on relevance"
  }
}

SEARCH TERMS RULES:
- Exactly 5 terms per subcategory.
- All terms MUST be in wildcard format (*word*word*).
- First term = most specific.

OTHER RULES:
- Focus ONLY on physical products.
- Subcategory names must be excellent search terms.`;

    const messages = [
        { role: 'system', content: systemContent },
        { 
            role: 'user', 
            content: 
`Club Information:
${JSON.stringify(context, null, 2)}

Generate discount categories ordered by relevance to the club's audience. 
Assign MainCategoryOrder and SubCategoryOrder (1 = most relevant). 
All searchTerms must be in wildcard format (*word*word*).`
        }
    ];

    const result = await callGrokStructured(messages, CATEGORY_SCHEMA, {
        temperature: 0.4,
        max_tokens: 6000
    });

    if (!result?.categories || Object.keys(result.categories).length < 6) {
        throw new Error('Grok returned insufficient categories');
    }

    return result.categories;
}

module.exports = { handle };