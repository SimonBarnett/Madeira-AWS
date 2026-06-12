// sqs/awin.js
// Awin Search Handler - Batch Size Splitting + Chunked Fetching + Retry
// Supports AFFILIATE_BATCH_SIZE env var + lastId for keyset pagination
// Chunked fetching + retry + exponential backoff + full logging
// Updated: 07 June 2026

const { 
    sql,
    logger 
} = require('/opt/nodejs/helpers');

const { getDbPool, closeDbPool } = require('/opt/nodejs/conf/db-config');

// ====================== TUNING PARAMETERS ======================
const BATCH_SIZE = parseInt(process.env.AFFILIATE_BATCH_SIZE, 10) || 100;
const CHUNK_SIZE = parseInt(process.env.AWIN_CHUNK_SIZE, 10) || 50;
const MAX_CHUNKS_PER_INVOCATION = parseInt(process.env.AWIN_MAX_CHUNKS_PER_INVOCATION, 10) || 4;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 400;

// ====================== HELPERS ======================
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function executeWithRetry(pool, queryFn, description) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            logger.debug(`Executing query: ${description} (attempt ${attempt}/${MAX_RETRIES})`);
            return await queryFn();
        } catch (err) {
            lastError = err;
            logger.warn(`Query failed: ${description} (attempt ${attempt})`, { error: err.message });

            if (attempt === MAX_RETRIES) break;

            const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
            logger.info(`Retrying in ${delay}ms...`);
            await sleep(delay);
        }
    }
    logger.error(`All retries exhausted for: ${description}`, { error: lastError.message });
    throw lastError;
}

// ====================== MAIN RUNNER ======================
async function run(event, externalPool = null) {
    const { 
        catalogId, 
        userid, 
        category, 
        subcategory, 
        searchterms = [],
        lastId = 0 
    } = event || {};

    logger.info('🚀 Awin START (KEYSET PAGINATION)', { 
        catalogId, 
        userid, 
        category, 
        subcategory, 
        lastId,
        batchSize: BATCH_SIZE,
        termsCount: searchterms.length 
    });

    if (!catalogId || !userid) {
        logger.error('❌ Missing catalogId or userid in Awin request');
        throw new Error('Missing catalogId or userid');
    }

    let pool = externalPool;
    let weCreatedPool = false;

    try {
        if (!pool) {
            pool = await getDbPool();
            weCreatedPool = true;
            logger.debug('Acquired new pooled DB connection for Awin handler');
        }

        const result = await performMerchantProductsSearch(
            pool, 
            catalogId, 
            userid, 
            category, 
            subcategory, 
            searchterms,
            lastId
        );

        logger.info(`✅ Awin batch completed`, { 
            catalogId, 
            lastId: result.lastId,
            productsReturned: result.products.length 
        });

        return result;   // Returns { products: [...], lastId: number }

    } catch (err) {
        logger.error('❌ Awin handler failed', { 
            catalogId, 
            lastId,
            error: err.message, 
            stack: err.stack 
        });
        throw err;
    } finally {
        if (weCreatedPool && pool) {
            try {
                await closeDbPool();
                logger.debug('Closed pooled connection (Awin created it)');
            } catch (closeErr) {
                logger.warn('Pool close warning in Awin handler', { error: closeErr.message });
            }
        }
    }
}

// ====================== CORE SEARCH ======================
async function performMerchantProductsSearch(pool, catalogId, userid, category, subcategory, searchterms = [], lastId = 0) {
    logger.info('🔎 Starting batch fetch (KEYSET PAGINATION)', { 
        catalogId, 
        lastId, 
        batchSize: BATCH_SIZE 
    });

    const cleanTerms = searchterms.filter(t => typeof t === 'string' && t.trim().length >= 3);
    const containsStr = cleanTerms.length > 0 
        ? cleanTerms.join(' OR ') 
        : `"${subcategory}"`;

    logger.info('🔍 EXACT CONTAINS VALUE SENT TO SERVER', {
        catalogId,
        containsStr,
        originalTerms: searchterms,
        termCount: cleanTerms.length
    });

    // ============================================================
    // LOW COST PRE-CHECK
    // Fast check to see if there is ANY matching non-rejected product
    // after the current lastId. Avoids unnecessary work on zero-result cases.
    // ============================================================
    const hasAnyMatch = await executeWithRetry(pool, async () => {
        const res = await pool.request()
            .input('uid', sql.NVarChar(100), userid)
            .input('cat', sql.NVarChar(510), category)
            .input('sub', sql.NVarChar(510), subcategory)
            .input('c', sql.NVarChar(4000), containsStr)
            .input('lastId', sql.Int, lastId)
            .query(`
                SELECT TOP 1 1 AS hasMatch
                FROM MerchantProducts mp
                WHERE CONTAINS((mp.Title, mp.Brand, mp.Category, mp.Subcategory), @c)
                  AND mp.ID > @lastId
                  AND NOT EXISTS (
                      SELECT 1 
                      FROM RejectedAsins r
                      WHERE r.UserId = @uid 
                        AND r.MainCategory = @cat 
                        AND r.SubCategory = @sub
                        AND r.ASIN = mp.ASIN
                  )
            `);
        return res.recordset.length > 0;
    }, 'Pre-check: any matching non-rejected products exist?');

    if (!hasAnyMatch) {
        logger.info('🛑 No matching products found after pre-check', { 
            catalogId, 
            lastId 
        });
        return {
            products: [],
            lastId: lastId
        };
    }

    // ============================================================
    // MAIN PAGINATION LOOP - No early exit
    // Keep searching until we hit BATCH_SIZE, MAX_CHUNKS_PER_INVOCATION,
    // or run out of matching records.
    // ============================================================
    let all = [];
    let currentLastId = lastId;
    let chunksProcessed = 0;

    while (all.length < BATCH_SIZE && chunksProcessed < MAX_CHUNKS_PER_INVOCATION) {

        const chunk = await executeWithRetry(pool, async () => {
            const res = await pool.request()
                .input('uid', sql.NVarChar(100), userid)
                .input('cat', sql.NVarChar(510), category)
                .input('sub', sql.NVarChar(510), subcategory)
                .input('c', sql.NVarChar(4000), containsStr)
                .input('lastId', sql.Int, currentLastId)
                .input('lim', sql.Int, CHUNK_SIZE)
                .query(`
                    SELECT 
                        mp.ID,
                        mp.ASIN as asin, 
                        mp.Source as source, 
                        mp.Title as title,
                        mp.Price as price,
                        mp.Discount as discount,
                        mp.WasPrice as was_price,
                        mp.AffiliateUrl as affiliate_url,
                        mp.ThumbnailUrl as thumbnail_url,
                        mp.Brand as brand,
                        mp.Features as features,
                        mp.LastUpdate
                    FROM MerchantProducts mp
                    WHERE CONTAINS((mp.Title, mp.Brand, mp.Category, mp.Subcategory), @c)
                      AND mp.ID > @lastId
                      AND NOT EXISTS (
                          SELECT 1 
                          FROM RejectedAsins r
                          WHERE r.UserId = @uid 
                            AND r.MainCategory = @cat 
                            AND r.SubCategory = @sub
                            AND r.ASIN = mp.ASIN
                      )
                    ORDER BY mp.ID ASC
                    OFFSET 0 ROWS FETCH NEXT @lim ROWS ONLY
                    OPTION (MAXDOP 1)
                `);
            return res.recordset || [];
        }, `Keyset fetch after ID=${currentLastId} (excluding rejected)`);

        chunksProcessed++;

        if (chunk.length === 0) {
            break;
        }

        all = all.concat(chunk);
        currentLastId = chunk[chunk.length - 1].ID;

        logger.info(`📊 Keyset after ID ${currentLastId} → ${chunk.length} kept (total: ${all.length})`, { 
            catalogId 
        });
    }

    logger.info(`✅ Awin batch finished (keyset)`, { 
        catalogId, 
        lastId: currentLastId, 
        totalProducts: all.length 
    });

    return {
        products: all.map(p => ({
            ...p,
            source: p.source || 'awin'
        })),
        lastId: currentLastId
    };
}

module.exports = { run };