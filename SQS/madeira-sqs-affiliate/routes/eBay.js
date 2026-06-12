// madeira-affiliate/routes/eBay.js
// eBay Search Handler - Returns results only
// All S3 upload and GROK_JOB logic has been removed (now handled in affiliate.js)
// Updated: 09 June 2026

const axios = require('axios');

const { 
    sql,
    logger, 
    getEbayConfig 
} = require('/opt/nodejs/helpers');

const { getDbPool, closeDbPool } = require('/opt/nodejs/conf/db-config');

// ====================== CONFIG ======================
const MAX_PAGES = parseInt(process.env.EBAY_MAX_PAGES || '5', 10);
const EBAY_REQUEST_INTERVAL_MS = 5000;
const GLOBAL_429_BACKOFF_MS = 180000;
const BATCH_SIZE = parseInt(process.env.AFFILIATE_BATCH_SIZE, 10) || 100;

// ====================== RATE LIMITER ======================
const EbayRateLimiter = {
    lastRequestTime: 0,
    backoffUntil: 0,

    async wait() {
        const now = Date.now();

        // Handle global 429 backoff first
        if (now < this.backoffUntil) {
            const waitTime = this.backoffUntil - now;
            logger.debug(`eBay global 429 backoff → waiting ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        // Normal rate limiting
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < EBAY_REQUEST_INTERVAL_MS) {
            const waitTime = EBAY_REQUEST_INTERVAL_MS - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        this.lastRequestTime = Date.now();
    },

    triggerBackoff() {
        this.backoffUntil = Date.now() + GLOBAL_429_BACKOFF_MS;
        logger.warn(`eBay 429 received — backing off for ${GLOBAL_429_BACKOFF_MS / 1000} seconds`);
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

    logger.info('🚀 eBay START', {
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

        const result = await performEbaySearch(pool, userid, category, subcategory, searchterms, lastId);

        logger.info(`✅ eBay search completed - ${result.products.length} products (batch)`, { 
            catalogId,
            totalFound: result.totalFound || result.products.length,
            returned: result.products.length,
            lastId: result.lastId
        });

        return result;

    } catch (err) {
        logger.error('❌ eBay handler failed', { catalogId, error: err.message });
        throw err;
    } finally {
        if (weCreatedPool && pool) {
            await closeDbPool().catch(() => {});
        }
    }
}

// ====================== CORE SEARCH ======================
async function performEbaySearch(pool, userid, category, subcategory, searchterms = [], lastId = 0) {
    let rawTerms = searchterms.length > 0 ? searchterms : [`${category} ${subcategory}`];

    const cleanTerms = rawTerms.map(term =>
        term.replace(/\*/g, ' ').replace(/\s+/g, ' ').trim()
    ).filter(Boolean);

    logger.info('🔎 eBay search (stop at first successful term)', { 
        original: rawTerms, 
        cleaned: cleanTerms,
        lastId
    });

    const rejectedResult = await getRejectedPairs(pool, userid, category, subcategory);
    const rejectedAsins = new Set(rejectedResult.map(r => r.ASIN));

    const token = await getEbayOAuthToken();
    let goodItems = [];
    const seenIds = new Set();
    let usedTerm = null;

    for (const keyword of cleanTerms) {
        if (goodItems.length > 0) break;

        logger.info(`Trying eBay search term: "${keyword}"`);

        for (let page = 0; page < MAX_PAGES; page++) {
            await EbayRateLimiter.wait();

            try {
                const params = new URLSearchParams({
                    q: keyword,
                    limit: '200',
                    offset: (page * 200).toString(),
                    fieldgroups: 'EXTENDED',
                    sort: 'relevance'
                });

                const response = await axios.get(
                    `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
                    {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'X-EBAY-C-MARKETPLACE-ID': process.env.EBAY_MARKETPLACE_ID || 'EBAY_GB'
                        }
                    }
                );

                const items = response.data.itemSummaries || [];

                for (const item of items) {
                    const itemId = item.itemId;
                    if (!itemId || seenIds.has(itemId)) continue;
                    if (rejectedAsins.has(itemId)) continue;

                    seenIds.add(itemId);
                    goodItems.push(item);
                }

                if (goodItems.length > 0 && !usedTerm) {
                    usedTerm = keyword;
                }

                if (!response.data.next) break;

            } catch (err) {
                const status = err.response?.status;

                if (status === 401) {
                    logger.error('🚨 eBay Authentication Failed (Unauthorized)', {
                        catalogId,
                        keyword,
                        page,
                        error: err.message || 'Unauthorized',
                        statusCode: 401
                    });
                    logger.error('eBay credentials are invalid or the OAuth token is expired. Aborting processing for this catalog.');
                    
                    // Stop all further processing immediately
                    throw new Error('eBay Unauthorized - aborting search');
                }

                if (status === 429) {
                    EbayRateLimiter.triggerBackoff();
                } else {
                    logger.error(`eBay API error for term "${keyword}"`, { error: err.message });
                }
                break;
            }
        }

        if (goodItems.length > 0) {
            logger.info(`eBay using term "${usedTerm}" → found ${goodItems.length} products`);
            break;
        }
    }

    // ====================== BATCHING SUPPORT ======================
    const startIndex = lastId || 0;
    const batch = goodItems.slice(startIndex, startIndex + BATCH_SIZE);
    const newLastId = startIndex + batch.length;
    const isLastBatch = newLastId >= goodItems.length;

    logger.info(`✅ eBay finished batch`, {
        totalFound: goodItems.length,
        returned: batch.length,
        lastId: newLastId,
        isLastBatch
    });

    return {
        products: batch.map(item => {
            const featuresParts = [
                item.shortDescription,
                item.specifications,
                item.product_description
            ].filter(Boolean);

            return {
                asin: item.itemId,
                source: 'ebay',
                title: item.title || '',
                price: item.price?.value ? `£${parseFloat(item.price.value).toFixed(2)}` : 'N/A',
                discount: item.marketingPrice?.discountAmount?.value 
                    ? `£${parseFloat(item.marketingPrice.discountAmount.value).toFixed(2)}` : 'N/A',
                was_price: item.marketingPrice?.originalPrice?.value 
                    ? `£${parseFloat(item.marketingPrice.originalPrice.value).toFixed(2)}` : null,
                affiliate_url: item.itemAffiliateWebUrl || item.itemWebUrl || '',
                thumbnail_url: item.image?.imageUrl || '',
                brand: item.brand || '',
                features: featuresParts.join(' | '),
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
            .input('affiliateKey', sql.NVarChar(50), 'ebay')
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
        logger.error('Failed to fetch rejected pairs for eBay', { error: err.message });
        return [];
    }
}

async function getEbayOAuthToken() {
    const config = await getEbayConfig();

    if (!config.EBAY_CLIENT_ID || !config.EBAY_CLIENT_SECRET) {
        logger.error('Missing eBay credentials in config');
        throw new Error('Missing eBay credentials in config');
    }

    const auth = Buffer.from(`${config.EBAY_CLIENT_ID}:${config.EBAY_CLIENT_SECRET}`).toString('base64');

    try {
        const response = await axios.post(
            'https://api.ebay.com/identity/v1/oauth2/token',
            'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${auth}`
                }
            }
        );
        return response.data.access_token;
    } catch (err) {
        const status = err.response?.status;

        if (status === 401) {
            logger.error('🚨 eBay OAuth Authentication Failed (Unauthorized)', {
                error: err.message || 'Unauthorized',
                statusCode: 401
            });
            logger.error('eBay Client ID / Secret are invalid. Aborting.');
        } else {
            logger.error('Failed to get eBay OAuth token', { error: err.message });
        }

        throw new Error('Failed to authenticate with eBay');
    }
}

module.exports = { run };