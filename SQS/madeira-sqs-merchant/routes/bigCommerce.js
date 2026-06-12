// routes/bigCommerce.js - FULL REWRITE - Clean, consistent, and aligned with current merchant handler
const axios = require('axios');
const { logger } = require('/opt/nodejs/helpers');

/**
 * Main handler for BigCommerce stores (V3 Catalog API)
 */
exports.handler = async (event) => {
    try {
        logger.info('Starting BigCommerce handler');

        const apiKeyData = event.apiKeyData;
        if (!apiKeyData) {
            throw new Error('Missing apiKeyData in event');
        }

        const { API_TOKEN: apiToken, STORE_HASH: storeHash, STORE_URL: siteId } = apiKeyData;

        if (!apiToken || !storeHash || !siteId || !siteId.startsWith('https://')) {
            throw new Error('Missing or invalid API_TOKEN, STORE_HASH or STORE_URL');
        }

        const baseUrl = `https://api.bigcommerce.com/stores/${storeHash}/v3/catalog`;
        const headers = {
            'X-Auth-Token': apiToken,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        };

        // Default currency
        const currency = 'GBP';

        // Fetch all products with pagination
        const rawProducts = await fetchAllProducts(baseUrl, headers);

        logger.info(`Fetched ${rawProducts.length} raw products from BigCommerce`);

        // Normalize products
        const normalizedProducts = normalizeProducts(rawProducts, siteId, currency);

        logger.info('BigCommerce handler completed successfully', { 
            totalNormalizedProducts: normalizedProducts.length 
        });

        return { products: normalizedProducts };

    } catch (error) {
        logger.error(`BigCommerce provider error: ${error.message}`, {
            stack: error.stack,
            responseStatus: error.response?.status,
            responseData: error.response?.data
        });
        throw error;
    }
};

// ====================== HELPER FUNCTIONS ======================

async function fetchAllProducts(baseUrl, headers) {
    let allProducts = [];
    let page = 1;
    const limit = 250;

    while (true) {
        const url = `${baseUrl}/products?limit=${limit}&page=${page}&include=primary_category,images,variants`;

        logger.debug(`Fetching BigCommerce products page ${page}`);

        try {
            const response = await axios.get(url, { headers });
            const products = response.data.data || [];

            logger.info(`BigCommerce page ${page} → ${products.length} products`);
            allProducts = allProducts.concat(products);

            if (products.length < limit) break;

            page++;
        } catch (error) {
            logger.error(`Failed to fetch BigCommerce products page ${page}`, { error: error.message });
            throw error;
        }
    }

    return allProducts;
}

function normalizeProducts(rawProducts, siteId, currency) {
    return rawProducts
        .map((product) => {
            const variants = product.variants || [];

            let originalPrices = [parseFloat(product.retail_price) || parseFloat(product.price) || 0];
            let discountedPrices = [parseFloat(product.sale_price) || parseFloat(product.price) || 0];

            if (variants.length > 0) {
                originalPrices = variants.map(v => parseFloat(v.retail_price) || parseFloat(v.price) || 0);
                discountedPrices = variants.map(v => parseFloat(v.sale_price) || parseFloat(v.price) || 0);
            }

            const originalPrice = Math.min(...originalPrices);
            const discountedPrice = Math.min(...discountedPrices);

            const description = product.description || '';
            const specifications = product.custom_fields 
                ? product.custom_fields.map(f => `${f.name}: ${f.value}`).join('\n') 
                : '';

            const categoryName = product.primary_category?.name || '';
            const sku = product.sku || (variants[0] && variants[0].sku) || '';
            const brand = '';
            const mainImageUrl = product.images && product.images.length > 0 
                ? product.images[0].url_standard 
                : '';
            const affiliatePath = product.custom_url?.url || '';
            const categoryId = product.primary_category_id?.toString() || '';
            const category = categoryName;
            const subcategory = '';

            return {
                id: product.id.toString(),
                name: product.name || '',
                currency,
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