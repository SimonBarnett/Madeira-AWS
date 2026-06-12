// routes/magento.js - FULL REWRITE - Clean, consistent, and aligned with current merchant handler
const axios = require('axios');
const { logger } = require('/opt/nodejs/helpers');

/**
 * Main handler for Magento stores (REST API V1)
 */
exports.handler = async (event) => {
    try {
        logger.info('Starting Magento handler');

        const apiKeyData = event.apiKeyData;
        if (!apiKeyData) {
            throw new Error('Missing apiKeyData in event');
        }

        const { ACCESS_TOKEN: apiToken, STORE_URL: siteId, STORE_CODE: storeCode } = apiKeyData;

        if (!apiToken || !siteId || !siteId.startsWith('https://')) {
            throw new Error('Missing or invalid ACCESS_TOKEN or STORE_URL');
        }

        // Clean trailing slash
        let baseUrl = siteId.trim();
        if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);

        const headers = {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
        };

        // Fetch currency
        const currency = await fetchCurrency(baseUrl, headers, storeCode);

        // Fetch all products with pagination
        const rawProducts = await fetchAllProducts(baseUrl, headers, storeCode);

        logger.info(`Fetched ${rawProducts.length} raw products from Magento`);

        // Normalize products
        const normalizedProducts = normalizeProducts(rawProducts, baseUrl, currency);

        logger.info('Magento handler completed successfully', { 
            totalNormalizedProducts: normalizedProducts.length 
        });

        return { products: normalizedProducts };

    } catch (error) {
        if (error.response) {
            const status = error.response.status;
            if (status === 429) {
                logger.error('Magento rate limit exceeded');
                throw new Error('Magento rate limit exceeded; retry later');
            } else if (status === 401) {
                logger.error('Invalid Magento access token or insufficient scopes');
                throw new Error('Invalid Magento access token or insufficient scopes');
            }
        }
        logger.error(`Magento provider error: ${error.message}`, {
            stack: error.stack,
            responseStatus: error.response?.status,
            responseData: error.response?.data
        });
        throw error;
    }
};

// ====================== HELPER FUNCTIONS ======================

async function fetchCurrency(baseUrl, headers, storeCode = null) {
    let url = `${baseUrl}/rest/V1/store/storeConfigs`;
    if (storeCode) url += `?storeCodes=${storeCode}`;

    logger.debug(`Fetching currency from ${url}`);

    try {
        const response = await axios.get(url, { headers });
        const currency = response.data[0]?.default_display_currency_code || 'GBP';
        logger.debug(`Fetched currency: ${currency}`);
        return currency;
    } catch (error) {
        logger.warn('Could not fetch currency, defaulting to GBP', { error: error.message });
        return 'GBP';
    }
}

async function fetchAllProducts(baseUrl, headers, storeCode = null) {
    let allProducts = [];
    let page = 1;
    const pageSize = 100;
    const RATE_LIMIT_DELAY_MS = 200;

    while (true) {
        let url = `${baseUrl}/rest/V1/products?searchCriteria[pageSize]=${pageSize}&searchCriteria[currentPage]=${page}`;

        if (storeCode) {
            url += `&searchCriteria[filterGroups][0][filters][0][field]=store_id&searchCriteria[filterGroups][0][filters][0][value]=${storeCode}`;
        }

        url += '&fields=items[id,sku,name,price,custom_attributes,extension_attributes,media_gallery_entries]';

        logger.debug(`Fetching Magento products page ${page}`);

        try {
            const response = await axios.get(url, { headers });
            const items = response.data.items || [];
            allProducts = allProducts.concat(items);

            logger.info(`Magento page ${page} → ${items.length} products`);

            const totalCount = response.data.total_count || 0;
            if (allProducts.length >= totalCount) break;

            page++;
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
        } catch (error) {
            logger.error(`Failed to fetch Magento products page ${page}`, { error: error.message });
            throw error;
        }
    }

    return allProducts;
}

function normalizeProducts(rawProducts, siteId, currency) {
    return rawProducts
        .map((product) => {
            const originalPrice = parseFloat(product.price) || 0;

            const specialPriceAttr = product.custom_attributes?.find(attr => attr.attribute_code === 'special_price');
            const discountedPrice = specialPriceAttr 
                ? parseFloat(specialPriceAttr.value) || originalPrice 
                : originalPrice;

            const descriptionAttr = product.custom_attributes?.find(attr => attr.attribute_code === 'description');
            const description = descriptionAttr ? descriptionAttr.value : '';

            const shortDescAttr = product.custom_attributes?.find(attr => attr.attribute_code === 'short_description');
            const specifications = shortDescAttr ? shortDescAttr.value : '';

            const categoryName = '';

            const sku = product.sku || '';

            const brandAttr = product.custom_attributes?.find(attr => attr.attribute_code === 'manufacturer');
            const brand = brandAttr ? brandAttr.value : '';

            let mainImageUrl = '';
            if (product.media_gallery_entries && product.media_gallery_entries.length > 0) {
                const mainImage = product.media_gallery_entries.find(img => img.types && img.types.includes('image')) 
                               || product.media_gallery_entries[0];
                mainImageUrl = mainImage.file 
                    ? `${siteId}/pub/media/catalog/product${mainImage.file}` 
                    : '';
            }

            const urlKeyAttr = product.custom_attributes?.find(attr => attr.attribute_code === 'url_key');
            const affiliatePath = urlKeyAttr && urlKeyAttr.value 
                ? `/${urlKeyAttr.value}.html` 
                : '';

            const categoryId = product.extension_attributes?.category_links?.[0]?.category_id?.toString() || '';

            const category = '';
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