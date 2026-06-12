// madeira-affiliate/routes/paapi.js
// PAAPI (Amazon) Search Handler - Returns results only
// All S3 upload and GROK_JOB logic has been removed (now handled in affiliate.js)
// Updated: 09 June 2026

const { ApiClient, DefaultApi } = require('paapi5-nodejs-sdk');

const { 
    sql,
    logger, 
    getAmazonConfig 
} = require('/opt/nodejs/helpers');

const { getDbPool, closeDbPool } = require('/opt/nodejs/conf/db-config');

// ====================== CONFIG ======================
const MAX_PAGES = parseInt(process.env.PAAPI_MAX_PAGES || '5', 10);
const BATCH_SIZE = parseInt(process.env.AFFILIATE_BATCH_SIZE, 10) || 100;

// ====================== RATE LIMITER ======================
const PaapiRateLimiter = {
    lastRequestTime: 0,
    requestIntervalMs: 1100,

    async wait() {
        const now = Date.now();
        const timeSinceLast = now - this.lastRequestTime;

        if (timeSinceLast < this.requestIntervalMs) {
            const waitTime = this.requestIntervalMs - timeSinceLast;
            logger.debug(`PAAPI rate limit → waiting ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        this.lastRequestTime = Date.now();
    }
};

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

    logger.info('🚀 PAAPI START', {
        catalogId,
        userid,
        category,
        subcategory,
        searchtermsCount: searchterms.length,
        lastId
    });

    if (!catalogId || !userid) {
        logger.error('❌ Missing catalogId or userid');
        throw new Error('Missing catalogId or userid');
    }

    let pool = externalPool;
    let weCreatedPool = false;

    try {
        if (!pool) {
            pool = await getDbPool();
            weCreatedPool = true;
        }

        const result = await performPaapiSearch(pool, catalogId, userid, category, subcategory, searchterms, lastId);

        logger.info(`✅ PAAPI search completed - ${result.products.length} products (batch)`, { 
            catalogId,
            totalFound: result.totalFound,
            returned: result.products.length,
            lastId: result.lastId
        });

        return result;

    } catch (err) {
        logger.error('❌ PAAPI handler failed', { catalogId, error: err.message });
        throw err;
    } finally {
        if (weCreatedPool && pool) {
            await closeDbPool().catch(() => {});
        }
    }
}

// ====================== CORE SEARCH ======================
async function performPaapiSearch(pool, catalogId, userid, category, subcategory, searchterms = [], lastId = 0) {
    const { api, associateTag } = await getPaapiClient();

    let rawTerms = searchterms.length > 0 ? searchterms : [`${category} ${subcategory}`];

    const cleanTerms = rawTerms.map(term =>
        term.replace(/\*/g, ' ').replace(/\s+/g, ' ').trim()
    ).filter(Boolean);

    logger.info('🔎 PAAPI search (stop at first successful term)', { 
        original: rawTerms, 
        cleaned: cleanTerms 
    });

    const rejectedResult = await getRejectedPairs(pool, userid, category, subcategory);
    const rejectedAsins = new Set(rejectedResult.map(r => r.ASIN));

    let goodItems = [];
    let usedTerm = null;

    for (const keyword of cleanTerms) {
        if (goodItems.length > 0) break;

        logger.info(`Trying PAAPI search term: "${keyword}"`);

        for (let page = 1; page <= MAX_PAGES; page++) {
            await PaapiRateLimiter.wait();

            try {
                const request = {
                    PartnerTag: associateTag,
                    PartnerType: 'Associates',
                    Keywords: keyword,
                    ItemPage: page,
                    Resources: [
                        'ItemInfo.Title',
                        'Offers.Listings.Price',
                        'Offers.Listings.SavingBasis',
                        'Images.Primary.Medium',
                        'ItemInfo.ByLineInfo'
                    ]
                };

                const response = await new Promise((resolve, reject) => {
                    api.searchItems(request, (error, data) => {
                        if (error) reject(error);
                        else resolve(data);
                    });
                });

                const items = response.SearchResult?.Items || [];

                for (const item of items) {
                    const asin = item.ASIN;
                    if (!asin || rejectedAsins.has(asin)) continue;

                    rejectedAsins.add(asin);
                    goodItems.push(item);
                }

                if (goodItems.length > 0 && !usedTerm) {
                    usedTerm = keyword;
                }

                if (items.length < 10) break;

            } catch (err) {
                const isUnauthorized = 
                    err.statusCode === 401 || 
                    (err.message && err.message.toLowerCase().includes('unauthorized'));

                if (isUnauthorized) {
                    logger.error('🚨 PAAPI Authentication Failed (Unauthorized)', {
                        catalogId,
                        keyword,
                        page,
                        error: err.message || 'Unauthorized',
                        statusCode: err.statusCode || 401
                    });
                    logger.error('PAAPI credentials are invalid or lack permission. Aborting processing for this catalog.');
                    
                    throw new Error('PAAPI Unauthorized - aborting search');
                }

                logger.warn(`PAAPI error on term "${keyword}" page ${page}`, { 
                    error: err.message 
                });
                break;
            }
        }

        if (goodItems.length > 0) {
            logger.info(`PAAPI using term "${usedTerm}" → found ${goodItems.length} products`);
            break;
        }
    }

    // ====================== BATCHING SUPPORT ======================
    const startIndex = lastId || 0;
    const batch = goodItems.slice(startIndex, startIndex + BATCH_SIZE);
    const newLastId = startIndex + batch.length;
    const isLastBatch = newLastId >= goodItems.length;

    logger.info(`✅ PAAPI finished batch`, {
        totalFound: goodItems.length,
        returned: batch.length,
        lastId: newLastId,
        isLastBatch
    });

    return {
        products: batch.map(item => {
            const listing = item.Offers?.Listings?.[0];
            const priceInfo = listing?.Price;
            const savingInfo = listing?.SavingBasis;

            return {
                asin: item.ASIN,
                source: 'paapi',
                title: item.ItemInfo?.Title?.DisplayValue || '',
                price: priceInfo?.DisplayAmount || 'N/A',
                discount: savingInfo?.Amount?.DisplayAmount || 'N/A',
                was_price: savingInfo?.Amount?.DisplayAmount 
                    ? priceInfo?.DisplayAmount 
                    : null,
                affiliate_url: `https://www.amazon.co.uk/dp/${item.ASIN}?tag=${associateTag}`,
                thumbnail_url: item.Images?.Primary?.Medium?.URL || '',
                brand: item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue || '',
                features: '',
                mpn: null,
                specifications: '',
                product_description: ''
            };
        }),
        lastId: newLastId,
        totalFound: goodItems.length
    };
}

// ====================== HELPERS ======================
async function getRejectedPairs(pool, userid, category, subcategory) {
    try {
        const result = await pool.request()
            .input('userId', sql.NVarChar(100), userid)
            .input('affiliateKey', sql.NVarChar(50), 'paapi')
            .input('mainCategory', sql.NVarChar(510), category)
            .input('subCategory', sql.NVarChar(510), subcategory)
            .query(`
                SELECT ASIN 
                FROM RejectedAsins 
                WHERE UserId = @userId 
                  AND AffiliateKey = @affiliateKey
                  AND MainCategory = @mainCategory 
                  AND SubCategory = @subCategory
            `);
        return result.recordset || [];
    } catch (err) {
        logger.error('Failed to fetch rejected pairs for PAAPI', { error: err.message });
        return [];
    }
}

async function getPaapiClient() {
    const config = await getAmazonConfig();

    if (!config.AMAZON_ACCESS_KEY) {
        logger.error('Missing AMAZON_ACCESS_KEY in Amazon config');
        throw new Error('Missing AMAZON_ACCESS_KEY');
    }

    if (!config.AMAZON_SECRET_KEY) {
        logger.error('Missing AMAZON_SECRET_KEY in Amazon config');
        throw new Error('Missing AMAZON_SECRET_KEY');
    }

    if (!config.AMAZON_ASSOCIATE_TAG) {
        logger.error('Missing AMAZON_ASSOCIATE_TAG in Amazon config');
        throw new Error('Missing AMAZON_ASSOCIATE_TAG');
    }

    if (!config.AMAZON_HOST) {
        logger.error('Missing AMAZON_HOST in Amazon config');
        throw new Error('Missing AMAZON_HOST');
    }

    if (!config.AMAZON_REGION) {
        logger.error('Missing AMAZON_REGION in Amazon config');
        throw new Error('Missing AMAZON_REGION');
    }

    const client = new ApiClient();
    client.accessKey = config.AMAZON_ACCESS_KEY;
    client.secretKey = config.AMAZON_SECRET_KEY;
    client.host = config.AMAZON_HOST;
    client.region = config.AMAZON_REGION;

    return {
        api: new DefaultApi(client),
        associateTag: config.AMAZON_ASSOCIATE_TAG
    };
}

module.exports = { run };