// routes/shopify.js - FULL REWRITE - Clean, consistent, and aligned with current merchant handler
const axios = require('axios');
const { logger } = require('/opt/nodejs/helpers');

/**
 * Main handler for Shopify stores
 * Handles pagination via Link header, rate limiting, and variant pricing
 */
exports.handler = async (event) => {
    try {
        logger.info('Starting Shopify handler');

        const apiKeyData = event.apiKeyData;
        if (!apiKeyData) {
            throw new Error('Missing apiKeyData in event');
        }

        const { ACCESS_TOKEN: apiToken, STORE_URL: siteId } = apiKeyData;
        const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-07';

        if (!apiToken || !siteId || !siteId.startsWith('https://') || !siteId.endsWith('.myshopify.com')) {
            throw new Error('Missing or invalid ACCESS_TOKEN or STORE_URL (must be https://*.myshopify.com)');
        }

        // Clean up trailing slash
        let baseUrl = siteId.trim();
        if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

        const headers = {
            'X-Shopify-Access-Token': apiToken,
            'Content-Type': 'application/json'
        };

        // Fetch shop currency
        const currency = await fetchShopCurrency(baseUrl, headers, apiVersion);

        // Fetch all products with pagination
        const rawProducts = await fetchAllProducts(baseUrl, headers, apiVersion);

        logger.info(`Fetched ${rawProducts.length} raw products from Shopify`);

        // Normalize products
        const normalizedProducts = normalizeProducts(rawProducts, currency);

        logger.info('Shopify handler completed successfully', { 
            totalNormalizedProducts: normalizedProducts.length 
        });

        return { products: normalizedProducts };

    } catch (error) {
        if (error.response) {
            const status = error.response.status;
            if (status === 429) {
                logger.error('Shopify rate limit exceeded');
                throw new Error('Shopify rate limit exceeded; retry later');
            } else if (status === 401) {
                logger.error('Invalid Shopify access token');
                throw new Error('Invalid Shopify access token');
            }
        }
        logger.error(`Shopify provider error: ${error.message}`, {
            stack: error.stack,
            responseStatus: error.response?.status,
            responseData: error.response?.data
        });
        throw error;
    }
};

// ====================== HELPER FUNCTIONS ======================

async function fetchShopCurrency(baseUrl, headers, apiVersion) {
    const url = `${baseUrl}/admin/api/${apiVersion}/shop.json`;
    logger.debug(`Fetching shop currency from ${url}`);

    try {
        const response = await axios.get(url, { headers });
        const currency = response.data.shop?.currency || 'GBP';
        logger.debug(`Fetched currency: ${currency}`);
        return currency;
    } catch (error) {
        logger.warn('Could not fetch currency, defaulting to GBP', { error: error.message });
        return 'GBP';
    }
}

async function fetchAllProducts(baseUrl, headers, apiVersion) {
    let allProducts = [];
    let url = `${baseUrl}/admin/api/${apiVersion}/products.json?limit=250`;
    const RATE_LIMIT_DELAY_MS = 500; // ~2 requests per second

    while (url) {
        logger.debug(`Fetching products from ${url}`);

        try {
            const response = await axios.get(url, { headers });
            const products = response.data.products || [];
            allProducts = allProducts.concat(products);

            logger.info(`Shopify page → ${products.length} products`);

            // Get next page from Link header
            const linkHeader = response.headers.link;
            url = null;
            if (linkHeader) {
                const nextLink = linkHeader.split(',').find(link => link.includes('rel="next"'));
                if (nextLink) {
                    url = nextLink.match(/<(.*)>/)[1];
                }
            }

            if (url) {
                await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
            }
        } catch (error) {
            logger.error(`Failed to fetch Shopify products`, { url, error: error.message });
            throw error;
        }
    }

    return allProducts;
}

function normalizeProducts(rawProducts, currency) {
    return rawProducts
        .map((product) => {
            const variants = product.variants || [];
            if (variants.length === 0) return null;

            // Get lowest prices across all variants
            const prices = variants.map(v => parseFloat(v.price) || 0);
            const comparePrices = variants.map(v => parseFloat(v.compare_at_price) || parseFloat(v.price) || 0);

            const minPrice = Math.min(...prices);
            const minCompare = Math.min(...comparePrices);

            const originalPrice = minCompare > minPrice ? minCompare : minPrice;
            const discountedPrice = minPrice;

            const description = product.body_html || '';
            const specifications = ''; // Can be extended later with metafields
            const categoryName = product.product_type || '';
            const sku = variants.map(v => v.sku).filter(Boolean).join(', ') || '';
            const brand = product.vendor || '';
            const mainImageUrl = product.images && product.images.length > 0 ? product.images[0].src : '';
            const affiliatePath = product.handle ? `/products/${product.handle}` : '';
            const categoryId = ''; // Not used in current Shopify structure
            const category = product.product_type || '';
            const subcategory = '';

            return {
                id: product.id.toString(),
                name: product.title || '',
                currency: currency || 'GBP',
                originalPrice,
                discountedPrice,
                description,
                specifications,
                categoryName,
                sku,
                brand,
                mainImageUrl,
                affiliatePath,
                categoryId,
                category,
                subcategory
            };
        })
        .filter(p => p && p.id && p.affiliatePath);
}