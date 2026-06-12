// sqs/grokPoll.js
// Unified GROK_POLL handler (Discovery + Chained Single-Batch Processing)
// Clean stopping logic + PascalCase fix + removed executeWithRetry dependency
// Updated: 10 June 2026

const { 
    logger, 
    sql,
    getS3Client,
    GetObjectCommand,
    DeleteObjectCommand,
    enqueueMessage
} = require('/opt/nodejs/helpers');

const { getDbPool, closeDbPool } = require('/opt/nodejs/conf/db-config');
const { getBatchStatus, getBatchResults } = require('/opt/nodejs/grok-batch');

// ====================== MAIN HANDLER ======================
async function run(event, externalPool = null) {
    const isSandbox = event?.sandbox === true;

    let pool = externalPool;
    let weCreatedPool = false;

    try {
        if (!pool) {
            pool = await getDbPool();
            weCreatedPool = true;
        }

        // =====================================================
        // CASE 1: Discovery Mode (no batchNames in event)
        // =====================================================
        if (!event.batchNames) {
            logger.info('🧠 GROK_POLL discovery started', { sandbox: isSandbox });

            const limitClause = isSandbox 
                ? 'OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY' 
                : '';

            const rows = await pool.request()
                .input('status', sql.NVarChar(50), 'batch_submitted')
                .query(`
                    SELECT cau.BatchName
                    FROM CatalogAffiliateUpdates cau
                    WHERE cau.Status = @status
                      AND cau.BatchName IS NOT NULL
                      AND (cau.NextCheck IS NULL OR cau.NextCheck <= GETDATE())
                      AND S3File IS NOT NULL
                    ORDER BY cau.LastUpdate ASC
                    ${limitClause}
                `);

            const batchNames = rows.recordset.map(r => r.BatchName);

            if (batchNames.length === 0) {
                logger.info('No batches ready for polling');
                return { statusCode: 200 };
            }

            logger.info(`Found ${batchNames.length} batch(es). Starting chained processing...`, {
                batchNames
            });

            await enqueueMessage({
                type: "GROK_POLL",
                batchNames,
                sandbox: isSandbox
            });

            return { statusCode: 200 };
        }

        // =====================================================
        // CASE 2: Chained Processing Mode
        // =====================================================
        const { batchNames } = event;

        // CASE 2a: Empty list → Chain is finished
        if (!Array.isArray(batchNames) || batchNames.length === 0) {
            logger.info('✅ GROK_POLL chain finished. No more batches.');
            return { statusCode: 200 };
        }

        // CASE 2b: Process current + enqueue remaining (if any)
        const currentBatchName = batchNames[batchNames.length - 1];
        const remainingBatches = batchNames.slice(0, -1);

        logger.info(`Processing batch (chained mode)`, {
            currentBatchName,
            remaining: remainingBatches.length
        });

        await resetStalePollingRecords(pool);
        await resetVeryOldBatches(pool);
        await processSingleBatch(pool, currentBatchName);

        if (remainingBatches.length > 0) {
            await enqueueMessage({
                type: "GROK_POLL",
                batchNames: remainingBatches,
                sandbox: isSandbox
            });
        } else {
            logger.info('✅ Last batch processed. Chain complete.');
        }

        return { statusCode: 200 };

    } catch (err) {
        logger.error('GROK_POLL failed', { error: err.message });
        throw err;
    } finally {
        if (weCreatedPool && pool) {
            await closeDbPool().catch(() => {});
        }
    }
}

// ====================== SINGLE BATCH PROCESSOR ======================
async function processSingleBatch(pool, batchName) {
    const rowResult = await pool.request()
        .input('batchName', sql.NVarChar(100), batchName)
        .query(`
            SELECT TOP 1 
                cau.CatalogId,
                cau.AffiliateKey,
                c.UserId,
                c.MainCategory,
                c.SubCategory,
                cau.S3File
            FROM CatalogAffiliateUpdates cau
            INNER JOIN Catalog c ON c.ID = cau.CatalogId
            WHERE cau.BatchName = @batchName
        `);

    if (rowResult.recordset.length === 0) {
        logger.warn('Batch not found', { batchName });
        return;
    }

    const row = rowResult.recordset[0];
    await updateBatchStatus(pool, row.CatalogId, row.AffiliateKey, 'polling');

    try {
        const statusResponse = await getBatchStatus(batchName);
        const state = statusResponse?.state || {};

        const numSuccess   = state.num_success   || 0;
        const numError     = state.num_error     || 0;
        const numCancelled = state.num_cancelled || 0;
        const numPending   = state.num_pending   || 0;
        const numRequests  = state.num_requests  || 0;

        const processed = numSuccess + numError + numCancelled;
        const successRate = numRequests > 0 ? (numSuccess / numRequests) * 100 : 0;

        logger.info('Grok batch status', {
            batchName,
            numRequests,
            numSuccess,
            numError,
            numPending,
            successRate: `${successRate.toFixed(1)}%`
        });

        const isFinished = (numPending === 0) || (processed === numRequests);

        if (isFinished && successRate >= 95) {
            await handleCompletedBatch(pool, { ...row, batchName });
        } else if (isFinished) {
            logger.warn('Batch finished with low success rate', { batchName, successRate });
            await updateBatchStatus(pool, row.CatalogId, row.AffiliateKey, 'results_ready');
        } else {
            await updateBatchStatus(pool, row.CatalogId, row.AffiliateKey, 'batch_submitted', true);
        }

    } catch (err) {
        logger.error('Error processing batch', { batchName, error: err.message });
        await updateBatchStatus(pool, row.CatalogId, row.AffiliateKey, 'batch_submitted').catch(() => {});
        throw err;
    }
}

// ====================== RESET & STATUS HELPERS ======================
async function resetStalePollingRecords(pool) {
    const result = await pool.request().query(`
        UPDATE CatalogAffiliateUpdates
        SET Status = 'batch_submitted', LastUpdate = GETDATE()
        WHERE Status = 'polling'
          AND LastUpdate < DATEADD(minute, -15, GETDATE())
    `);

    if (result.rowsAffected[0] > 0) {
        logger.warn(`Reset ${result.rowsAffected[0]} stuck polling record(s)`);
    }
}

async function resetVeryOldBatches(pool) {
    const result = await pool.request().query(`
        UPDATE CatalogAffiliateUpdates
        SET Status = 'results_ready', LastUpdate = GETDATE()
        WHERE Status IN ('batch_submitted', 'polling')
          AND LastUpdate < DATEADD(hour, -24, GETDATE())
    `);

    if (result.rowsAffected[0] > 0) {
        logger.warn(`Reset ${result.rowsAffected[0]} very old batch(es)`);
    }
}

async function updateBatchStatus(pool, catalogId, affiliateKey, status, setNextCheck = false) {
    const request = pool.request()
        .input('catalogId', sql.Int, catalogId)
        .input('affiliateKey', sql.NVarChar(50), affiliateKey || 'awin')
        .input('status', sql.NVarChar(50), status);

    let nextCheckClause = setNextCheck 
        ? ', NextCheck = DATEADD(minute, 10, GETDATE())' 
        : '';

    await request.query(`
        UPDATE CatalogAffiliateUpdates
        SET Status = @status, LastUpdate = GETDATE()
        ${nextCheckClause}
        WHERE CatalogId = @catalogId AND AffiliateKey = @affiliateKey
    `);
}

// ====================== COMPLETED BATCH HANDLER ======================
async function handleCompletedBatch(pool, row) {
    const { CatalogId, AffiliateKey, UserId, MainCategory, SubCategory, S3File, batchName } = row;

    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
        const grokResults = await getBatchResults(batchName);
        const originalProducts = await readProductsFromS3(S3File);

        const { relevantItems, rejectedDecisions } = matchGrokResults(originalProducts, grokResults);

        if (rejectedDecisions.length > 0) {
            await bulkInsertRejectedAsins(transaction, UserId, AffiliateKey, MainCategory, SubCategory, rejectedDecisions);
        }

        if (relevantItems.length > 0) {
            await bulkUpsertProducts(transaction, relevantItems, UserId, MainCategory, SubCategory, AffiliateKey);
        }

        await finalizeBatch(transaction, CatalogId, AffiliateKey);
        await deleteS3File(S3File);

        await transaction.commit();
        logger.info('✅ Batch completed successfully', { batchName });

    } catch (err) {
        await transaction.rollback();

        if (err.code === 'S3_FILE_NOT_FOUND' || err.message?.includes('The specified key does not exist')) {
            logger.warn('S3 results file missing — cleaning up', { 
                catalogId: CatalogId, 
                affiliateKey: AffiliateKey, 
                s3Key: S3File 
            });

            await pool.request()
                .input('catalogId', sql.Int, CatalogId)
                .input('affiliateKey', sql.NVarChar(50), AffiliateKey || 'awin')
                .query(`
                    UPDATE CatalogAffiliateUpdates
                    SET Status = 'results_ready', S3File = NULL, LastUpdate = GETDATE()
                    WHERE CatalogId = @catalogId AND AffiliateKey = @affiliateKey
                `);
            return;
        }

        logger.error('Failed to complete batch processing', { batchName, error: err.message });
        throw err;
    }
}

async function finalizeBatch(transaction, catalogId, affiliateKey) {
    await transaction.request()
        .input('catalogId', sql.Int, catalogId)
        .input('affiliateKey', sql.NVarChar(50), affiliateKey || 'awin')
        .query(`
            UPDATE CatalogAffiliateUpdates
            SET Status = 'completed', S3File = NULL, LastUpdate = GETDATE()
            WHERE CatalogId = @catalogId AND AffiliateKey = @affiliateKey
        `);
}

// ====================== BULK OPERATIONS ======================
async function bulkInsertRejectedAsins(transaction, userId, affiliateKey, category, subcategory, rejectedDecisions) {
    if (!rejectedDecisions || rejectedDecisions.length === 0) return;

    const uniqueMap = new Map();
    for (const d of rejectedDecisions) {
        const asin = d.asin || d.ASIN;
        if (asin && !uniqueMap.has(asin)) {
            uniqueMap.set(asin, {
                asin,
                reason: (d.reason || d.Reason || '').substring(0, 255)
            });
        }
    }

    const uniqueDecisions = Array.from(uniqueMap.values());
    if (uniqueDecisions.length === 0) return;

    const BATCH_SIZE = 200;

    for (let i = 0; i < uniqueDecisions.length; i += BATCH_SIZE) {
        const batch = uniqueDecisions.slice(i, i + BATCH_SIZE);

        const valuesPlaceholders = batch.map((_, idx) => 
            `(@userId, @affiliateKey, @category, @subcategory, @asin${idx}, @reason${idx})`
        ).join(',');

        const request = transaction.request()
            .input('userId', sql.NVarChar(100), userId)
            .input('affiliateKey', sql.NVarChar(50), affiliateKey)
            .input('category', sql.NVarChar(510), category)
            .input('subcategory', sql.NVarChar(510), subcategory);

        batch.forEach((d, idx) => {
            request.input(`asin${idx}`, sql.NVarChar(50), d.asin);
            request.input(`reason${idx}`, sql.NVarChar(255), d.reason);
        });

        await request.query(`
            INSERT INTO RejectedAsins (UserId, AffiliateKey, MainCategory, SubCategory, ASIN, Reason)
            SELECT v.*
            FROM (VALUES ${valuesPlaceholders}) AS v (UserId, AffiliateKey, MainCategory, SubCategory, ASIN, Reason)
            WHERE NOT EXISTS (
                SELECT 1 FROM RejectedAsins r 
                WHERE r.UserId = v.UserId 
                  AND r.AffiliateKey = v.AffiliateKey 
                  AND r.MainCategory = v.MainCategory 
                  AND r.SubCategory = v.SubCategory 
                  AND r.ASIN = v.ASIN
            )
        `);
    }
}

async function bulkUpsertProducts(transaction, items, userId, category, subcategory, affiliateKey) {
    if (!items || items.length === 0) return;

    const now = new Date();
    const BATCH_SIZE = 50;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);

        for (const item of batch) {
            const asin = item.asin || item.ASIN;
            const price         = item.price ?? item.Price ?? 'N/A';
            const discount      = item.discount ?? item.Discount ?? 'N/A';
            const wasPrice      = item.was_price ?? item.WasPrice ?? item.wasPrice ?? null;
            const affiliateUrl  = item.affiliate_url ?? item.AffiliateUrl ?? item.affiliateUrl ?? null;
            const thumbnailUrl  = item.thumbnail_url ?? item.ThumbnailUrl ?? item.thumbnailUrl ?? null;
            const brand         = item.brand ?? item.Brand ?? null;
            const features      = item.features ?? item.Features ?? null;

            await transaction.request()
                .input('userId', sql.NVarChar(100), userId)
                .input('category', sql.NVarChar(510), category)
                .input('subcategory', sql.NVarChar(510), subcategory)
                .input('asin', sql.NVarChar(50), asin)
                .input('source', sql.NVarChar(50), affiliateKey)
                .input('title', sql.NVarChar(1000), item.title || item.Title || '')
                .input('price', sql.NVarChar(50), price)
                .input('discount', sql.NVarChar(50), discount)
                .input('wasPrice', sql.NVarChar(50), wasPrice)
                .input('affiliateUrl', sql.NVarChar(1000), affiliateUrl)
                .input('thumbnailUrl', sql.NVarChar(1000), thumbnailUrl)
                .input('brand', sql.NVarChar(255), brand)
                .input('features', sql.NVarChar(4000), features)
                .input('reason', sql.NVarChar(255), item.grokReason || null)
                .input('lastUpdate', sql.DateTime, now)
                .query(`
                    MERGE INTO Products AS target
                    USING (SELECT @userId AS UserId, 
                                  @category AS Category, 
                                  @subcategory AS SubCategory, 
                                  @asin AS ASIN, 
                                  @source AS Source) AS source
                    ON target.UserId = source.UserId 
                       AND target.Category = source.Category 
                       AND target.SubCategory = source.SubCategory 
                       AND target.ASIN = source.ASIN
                    WHEN MATCHED THEN
                        UPDATE SET 
                            Title = @title,
                            Price = @price,
                            Discount = @discount,
                            WasPrice = @wasPrice,
                            AffiliateUrl = @affiliateUrl,
                            ThumbnailUrl = @thumbnailUrl,
                            Brand = @brand,
                            Features = @features,
                            Reason = @reason,
                            LastUpdate = @lastUpdate
                    WHEN NOT MATCHED THEN
                        INSERT (UserId, Category, SubCategory, ASIN, Source, Title, Price, Discount, 
                                WasPrice, AffiliateUrl, ThumbnailUrl, Brand, Features, Reason, LastUpdate)
                        VALUES (@userId, @category, @subcategory, @asin, @source, @title, @price, @discount, 
                                @wasPrice, @affiliateUrl, @thumbnailUrl, @brand, @features, @reason, @lastUpdate);
                `);
        }
    }
}

// ====================== GROK RESULT MATCHING ======================
function matchGrokResults(originalProducts, grokResults) {
    const relevantItems = [];
    const rejectedDecisions = [];
    const decisionMap = new Map();

    for (const result of grokResults) {
        try {
            let chatCompletion = null;

            if (result.response?.body?.choices) {
                chatCompletion = result.response.body;
            } else if (result.batch_result?.response?.chat_get_completion?.choices) {
                chatCompletion = result.batch_result.response.chat_get_completion;
            } else if (result.batch_result?.body?.choices) {
                chatCompletion = result.batch_result.body;
            } else if (result.batch_result?.choices) {
                chatCompletion = result.batch_result;
            } else if (result.body?.choices) {
                chatCompletion = result.body;
            } else if (result.choices) {
                chatCompletion = result;
            }

            if (!chatCompletion?.choices?.[0]) continue;

            const choice = chatCompletion.choices[0];
            const content = choice.message?.content || choice.content;
            if (!content) continue;

            let parsed;
            try {
                parsed = JSON.parse(content);
            } catch {
                continue;
            }

            if (Array.isArray(parsed)) {
                for (const decision of parsed) {
                    if (decision?.ASIN) decisionMap.set(decision.ASIN, decision);
                }
            } else if (parsed?.ASIN) {
                decisionMap.set(parsed.ASIN, parsed);
            }

        } catch (e) {
            logger.error('Error processing Grok result', { error: e.message });
        }
    }

    for (const product of originalProducts) {
        const asin = product.asin || product.ASIN;
        const decision = decisionMap.get(asin);

        if (decision) {
            const isRelevant = decision.IsRelevant === true;
            const reason = (decision.Reason || '').substring(0, 255);

            if (isRelevant) {
                relevantItems.push({ ...product, grokReason: reason });
            } else {
                rejectedDecisions.push({ asin, reason });
            }
        } else {
            logger.warn('No Grok decision found for product', { asin: product.asin || product.ASIN });
        }
    }

    return { relevantItems, rejectedDecisions };
}

// ====================== S3 HELPERS ======================
async function readProductsFromS3(s3Key) {
    try {
        const s3Client = await getS3Client();
        const command = new GetObjectCommand({
            Bucket: process.env.S3_RESULTS_BUCKET,
            Key: s3Key
        });
        const response = await s3Client.send(command);
        const body = await streamToString(response.Body);
        return JSON.parse(body);
    } catch (err) {
        if (err.name === 'NoSuchKey' || err.message?.includes('The specified key does not exist')) {
            const error = new Error(`S3 file not found: ${s3Key}`);
            error.code = 'S3_FILE_NOT_FOUND';
            throw error;
        }
        logger.error('Failed to read S3 results file', { s3Key, error: err.message });
        throw err;
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

async function deleteS3File(s3Key) {
    try {
        const s3Client = await getS3Client();
        await s3Client.send(new DeleteObjectCommand({
            Bucket: process.env.S3_RESULTS_BUCKET,
            Key: s3Key
        }));
    } catch (err) {
        logger.warn('Failed to delete S3 file', { s3Key, error: err.message });
    }
}

module.exports = { run };