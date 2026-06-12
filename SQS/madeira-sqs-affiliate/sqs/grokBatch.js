// sqs/grokBatch.js
// Triggered only when affiliate results are ready (S3 download complete)
// No scheduled runs - purely event driven
// Includes self-healing for stuck records (S3File not null + BatchName null + old LastUpdate)
// Updated: 10 June 2026

const { 
    logger, 
    sql,
    getS3Client,
    GetObjectCommand,
    getGrokConfig,
    enqueueMessage
} = require('/opt/nodejs/helpers');

const { getDbPool, closeDbPool } = require('/opt/nodejs/conf/db-config');
const { submitStructuredBatch } = require('/opt/nodejs/grok-batch');
const { calculateRecommendedMaxTokens } = require('/opt/nodejs/token-estimator');

// ====================== GROK RELEVANCE SCHEMA ======================
const GROK_RELEVANCE_SCHEMA = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "ASIN": { "type": "string" },
            "Source": { "type": "string" },
            "IsRelevant": { "type": "boolean" },
            "MainCategory": { "type": "string" },
            "SubCategory": { "type": "string" },
            "Reason": { "type": "string" }
        },
        "required": ["ASIN", "Source", "IsRelevant", "Reason"],
        "additionalProperties": false
    }
};

async function run(input, externalPool = null) {
    let pool = externalPool;
    let weCreatedPool = false;

    try {
        if (!pool) {
            pool = await getDbPool();
            weCreatedPool = true;
        }

        // Support both single message and SQS batch
        const messages = [];

        if (input?.catalogId && input?.affiliateKey) {
            messages.push(input);
        } else if (input?.Records) {
            for (const record of input.Records) {
                try {
                    const msg = JSON.parse(record.body);
                    if (msg.catalogId && msg.affiliateKey) {
                        messages.push(msg);
                    }
                } catch {
                    logger.error('Failed to parse GROK_BATCH message');
                }
            }
        }

        for (const msg of messages) {
            await processOneCategory(pool, msg);
        }

        // ====================== SELF-HEALING: Check for stuck records ======================
        await enqueueStuckBatches(pool);

        return { statusCode: 200 };

    } catch (err) {
        logger.error('GROK_BATCH failed', { error: err.message });
        throw err;
    } finally {
        if (weCreatedPool && pool) {
            await closeDbPool().catch(() => {});
        }
    }
}

async function processOneCategory(pool, msg) {
    const { catalogId, affiliateKey } = msg;

    const result = await pool.request()
        .input('catalogId', sql.Int, catalogId)
        .input('affiliateKey', sql.NVarChar(50), affiliateKey)
        .query(`
            SELECT 
                cau.CatalogId,
                cau.AffiliateKey,
                c.UserId,
                c.MainCategory,
                c.SubCategory,
                cau.S3File
            FROM CatalogAffiliateUpdates cau
            INNER JOIN Catalog c ON c.ID = cau.CatalogId
            WHERE cau.CatalogId = @catalogId 
              AND cau.AffiliateKey = @affiliateKey
              AND cau.Status = 'results_ready'
              AND cau.S3File IS NOT NULL
        `);

    if (result.recordset.length === 0) {
        logger.warn('No results_ready record with S3File found', { catalogId, affiliateKey });
        return;
    }

    await createGrokBatch(pool, result.recordset[0]);
}

async function createGrokBatch(pool, row) {
    const { CatalogId, AffiliateKey, UserId, MainCategory, SubCategory, S3File } = row;

    let products = [];
    try {
        products = await readProductsFromS3(S3File);
    } catch (err) {
        if (err.code === 'S3_FILE_NOT_FOUND') {
            logger.warn('S3 file missing — resetting record', { catalogId: CatalogId, affiliateKey: AffiliateKey });
            await pool.request()
                .input('catalogId', sql.Int, CatalogId)
                .input('affiliateKey', sql.NVarChar(50), AffiliateKey)
                .query(`
                    UPDATE CatalogAffiliateUpdates
                    SET Status = 'results_ready', S3File = NULL, LastUpdate = GETDATE()
                    WHERE CatalogId = @catalogId AND AffiliateKey = @affiliateKey
                `);
            return;
        }
        throw err;
    }

    if (!products.length) {
        logger.warn('No products found in S3 file', { catalogId: CatalogId, s3Key: S3File });
        return;
    }

    const clubDescription = await getClubDescription(pool, UserId);
    if (!clubDescription) {
        logger.error('Club description missing — aborting Grok batch', { catalogId: CatalogId });
        return;
    }

    const GROK_BATCH_SIZE = parseInt(process.env.GROK_BATCH_SIZE, 10) || 10;
    const MAX_TEXT = parseInt(process.env.MAX_TEXT, 10) || 500;
    const grokConfig = await getGrokConfig();

    const truncatedClubDescription = clubDescription.length > MAX_TEXT 
        ? clubDescription.substring(0, MAX_TEXT) + '...' 
        : clubDescription;

    // Split into chunks
    const chunks = [];
    for (let i = 0; i < products.length; i += GROK_BATCH_SIZE) {
        chunks.push(products.slice(i, i + GROK_BATCH_SIZE));
    }

    const baseTimestamp = Date.now();

    const batchRequests = chunks.map((chunk, chunkIndex) => {
        const productList = chunk.map(p => {
            const features = (p.features || '').toString();
            const truncatedFeatures = features.length > MAX_TEXT 
                ? features.substring(0, MAX_TEXT) + '...' 
                : features;

            return {
                ASIN: p.asin || p.ASIN,
                Source: p.source || AffiliateKey,
                Title: p.title || '',
                Brand: p.brand || '',
                Price: p.price || p.Price || null,
                Features: truncatedFeatures || null
            };
        });

        const systemPrompt = `You are an expert product relevance evaluator for a family discount club.

You will receive a list of products. For each product decide if it is relevant for the SubCategory.

Rules:
- Be practical and lenient.
- Only reject clearly unrelated products.
- Return ONLY a valid JSON array.

MainCategory: ${MainCategory}
SubCategory: ${SubCategory}
Club context: ${truncatedClubDescription}`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(productList) }
        ];

        const max_tokens = calculateRecommendedMaxTokens(messages, {
            schema: GROK_RELEVANCE_SCHEMA,
            expectedResults: productList.length,
            safetyMargin: 1.3
        });

        return {
            custom_id: `relevance-${CatalogId}-${baseTimestamp}-${chunkIndex}`,
            messages,
            max_tokens
        };
    });

    logger.info('Submitting Grok batch to xAI', {
        catalogId: CatalogId,
        totalProducts: products.length,
        chunks: batchRequests.length
    });

    const batch = await submitStructuredBatch(batchRequests, GROK_RELEVANCE_SCHEMA, {
        model: grokConfig.DEFAULT_MODEL,
        temperature: 0.1
    });

    await pool.request()
        .input('catalogId', sql.Int, CatalogId)
        .input('affiliateKey', sql.NVarChar(50), AffiliateKey)
        .input('batchName', sql.NVarChar(100), batch.batch_id)
        .input('status', sql.NVarChar(50), 'batch_submitted')
        .query(`
            UPDATE CatalogAffiliateUpdates
            SET 
                BatchName = @batchName,
                Status = @status,
                LastUpdate = GETDATE(),
                NextCheck = DATEADD(minute, 10, GETDATE())
            WHERE CatalogId = @catalogId 
              AND AffiliateKey = @affiliateKey
        `);

    logger.info('✅ GROK BATCH CREATED', {
        catalogId: CatalogId,
        affiliate: AffiliateKey,
        totalProducts: products.length,
        xaiBatchId: batch.batch_id
    });
}

// ====================== SELF-HEALING: Enqueue stuck records ======================
async function enqueueStuckBatches(pool) {
    const result = await pool.request().query(`
        SELECT TOP 1 
            CatalogId, 
            AffiliateKey
        FROM CatalogAffiliateUpdates
        WHERE S3File IS NOT NULL
          AND BatchName IS NULL
          AND Status = 'results_ready'
          AND LastUpdate < DATEADD(minute, -10, GETDATE())
        ORDER BY LastUpdate ASC
    `);

    if (result.recordset.length > 0) {
        const stuck = result.recordset[0];

        await enqueueMessage({
            type: "GROK_BATCH",
            catalogId: stuck.CatalogId,
            affiliateKey: stuck.AffiliateKey
        });

        logger.warn('Re-enqueued stuck GROK_BATCH record (self-healing)', {
            catalogId: stuck.CatalogId,
            affiliateKey: stuck.AffiliateKey
        });
    }
}

// ====================== HELPERS ======================

async function readProductsFromS3(s3Key) {
    const s3Client = await getS3Client();
    const command = new GetObjectCommand({
        Bucket: process.env.S3_RESULTS_BUCKET,
        Key: s3Key
    });
    const response = await s3Client.send(command);
    const body = await streamToString(response.Body);
    return JSON.parse(body);
}

function streamToString(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
}

async function getClubDescription(pool, userId) {
    const result = await pool.request()
        .input('userId', sql.NVarChar(100), userId)
        .query(`
            SELECT TOP 1 JsonResult 
            FROM clubscan 
            WHERE ClubID = @userId 
            ORDER BY UpdatedAt DESC
        `);

    if (result.recordset.length === 0) return null;

    const raw = result.recordset[0].JsonResult;
    if (typeof raw === 'string') {
        try { return JSON.parse(raw).review || raw; } 
        catch { return raw; }
    }
    return '';
}

module.exports = { run };