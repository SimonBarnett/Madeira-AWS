// madeira-affiliate/sqs/affiliate.js
// PROCESS_CATEGORY handler - All results go into ONE S3 file
// Supports batching via AFFILIATE_BATCH_SIZE + lastId (keyset pagination)
// Enqueues GROK_BATCH when final results are ready
// Updated: 10 June 2026

const { 
    logger, 
    sql,
    getS3Client, 
    PutObjectCommand,
    GetObjectCommand,
    enqueueMessage
} = require('/opt/nodejs/helpers');

const { getDbPool, closeDbPool } = require('/opt/nodejs/conf/db-config');

const S3_RESULTS_BUCKET = process.env.S3_RESULTS_BUCKET;
const BATCH_SIZE = parseInt(process.env.AFFILIATE_BATCH_SIZE, 10) || 100;

const awinHandler  = require('../routes/awin');
const paapiHandler = require('../routes/paapi');
const ebayHandler  = require('../routes/eBay');

const AFFILIATE_HANDLERS = {
    awin:   awinHandler.run,
    paapi:  paapiHandler.run,
    ebay:   ebayHandler.run,
};

async function run(msg, externalPool = null) {
    const { 
        affiliate, 
        catalogId, 
        userId, 
        category, 
        subcategory, 
        searchterms,
        lastId = 0 
    } = msg;

    if (!affiliate || !catalogId || !userId || !category || !subcategory) {
        logger.error('❌ Missing required fields in PROCESS_CATEGORY message', { received: Object.keys(msg) });
        return { statusCode: 400, body: 'Missing required fields' };
    }

    const handler = AFFILIATE_HANDLERS[affiliate.toLowerCase().trim()];
    if (!handler) {
        logger.error(`❌ Unknown affiliate: ${affiliate}`);
        return { statusCode: 400, body: `Unknown affiliate: ${affiliate}` };
    }

    logger.info(`📥 PROCESS_CATEGORY → ${affiliate.toUpperCase()}`, { 
        catalogId, 
        userId, 
        lastId,
        batchSize: BATCH_SIZE 
    });

    const payload = {
        catalogId,
        userid: userId,
        category,
        subcategory,
        searchterms: searchterms || [],
        lastId
    };

    let pool = externalPool;
    let weCreatedPool = false;

    try {
        if (!pool) {
            pool = await getDbPool();
            weCreatedPool = true;
        }

        const handlerResult = await handler(payload, pool);

        // Support both old array return and new { products, lastId, totalFound } return
        const rawResults = Array.isArray(handlerResult) 
            ? handlerResult 
            : handlerResult.products || [];

        const newLastId = handlerResult.lastId || 0;
        const totalFound = handlerResult.totalFound || rawResults.length;

        if (!rawResults || rawResults.length === 0) {
            logger.info('No products returned from affiliate', { affiliate, catalogId, lastId });
            return { statusCode: 200 };
        }

        // Filter out incomplete products
        const newResults = rawResults.filter((p, index) => {
            const hasTitle = !!(p.title || p.Title);
            const hasUrl   = !!(p.affiliate_url || p.AffiliateUrl || p.affiliateUrl);

            if ((!hasTitle || !hasUrl) && index < 2) {
                logger.warn('REJECTED PRODUCT SAMPLE', { product: p });
            }

            return hasTitle && hasUrl;
        });

        if (newResults.length !== rawResults.length) {
            logger.warn('Filtered out incomplete products before writing to S3', {
                affiliate,
                catalogId,
                original: rawResults.length,
                kept: newResults.length,
                removed: rawResults.length - newResults.length
            });
        }

        if (newResults.length === 0) {
            logger.info('All products filtered out (missing required fields)', { affiliate, catalogId, lastId });
            return { statusCode: 200 };
        }

        // Determine if this is the last batch
        const isLastBatch = newResults.length < BATCH_SIZE || 
                            (newLastId > 0 && newLastId >= totalFound);

        const s3Key = `${affiliate}/${userId}/${catalogId}.json`;

        // Read existing results (if any)
        let existingResults = [];
        try {
            const s3Client = await getS3Client();
            const response = await s3Client.send(new GetObjectCommand({
                Bucket: S3_RESULTS_BUCKET,
                Key: s3Key
            }));
            const body = await streamToString(response.Body);
            existingResults = JSON.parse(body);
        } catch (err) {
            if (err.name !== 'NoSuchKey') {
                logger.warn('Error reading existing S3 results file', { s3Key, error: err.message });
            }
        }

        const allResults = existingResults.concat(newResults);

        const s3Client = await getS3Client();
        await s3Client.send(new PutObjectCommand({
            Bucket: S3_RESULTS_BUCKET,
            Key: s3Key,
            Body: JSON.stringify(allResults),
            ContentType: 'application/json'
        }));

        logger.info('✅ Results merged and uploaded to S3', { 
            affiliate, 
            catalogId, 
            previousLastId: lastId,
            newLastId,
            newCount: newResults.length,
            totalCount: allResults.length,
            totalFound,
            isLastBatch 
        });

        if (isLastBatch) {
            // Mark as results_ready in database
            await pool.request()
                .input('catalogId', sql.Int, catalogId)
                .input('affiliateKey', sql.NVarChar(50), affiliate)
                .input('s3File', sql.NVarChar(500), s3Key)
                .input('status', sql.NVarChar(50), 'results_ready')
                .query(`
                    UPDATE CatalogAffiliateUpdates 
                    SET S3File = @s3File, Status = @status, LastUpdate = GETDATE()
                    WHERE CatalogId = @catalogId AND AffiliateKey = @affiliateKey
                `);

            logger.info('✅ CatalogAffiliateUpdates marked as results_ready', { catalogId, affiliate });

            // === NEW: Enqueue GROK_BATCH immediately ===
            await enqueueMessage({
                type: "GROK_BATCH",
                catalogId,
                affiliateKey: affiliate
            });

            logger.info('🚀 Enqueued GROK_BATCH for processing', { catalogId, affiliate });

        } else {
            // Enqueue next batch of affiliate results
            await enqueueMessage({
                type: "PROCESS_CATEGORY",
                affiliate,
                catalogId,
                userId,
                category,
                subcategory,
                searchterms: searchterms || [],
                lastId: newLastId
            });

            logger.info('🔄 Enqueued next affiliate batch', { 
                affiliate, 
                catalogId, 
                newLastId,
                totalFound
            });
        }

        return { statusCode: 200 };

    } catch (err) {
        logger.error(`❌ ${affiliate.toUpperCase()} handler failed`, {
            catalogId,
            lastId,
            error: err.message
        });
        throw err;
    } finally {
        if (weCreatedPool && pool) {
            await closeDbPool().catch(() => {});
        }
    }
}

function streamToString(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
}

module.exports = { run };