// routes/wixStore.js - FULL REWRITE - Clean, consistent, and aligned with current merchant handler
const axios = require('axios');
const { logger } = require('/opt/nodejs/helpers');

/**
 * Main handler for Wix stores
 * Handles automatic version detection (v1/v2/v3) and returns normalized products
 */
exports.handler = async (event) => {
    try {
        logger.info('Starting Wix handler');

        const apiKeyData = event.apiKeyData;
        if (!apiKeyData) {
            throw new Error('Missing apiKeyData in event');
        }

        const { API_TOKEN: apiToken, SITE_ID: siteId } = apiKeyData;

        if (!apiToken || !siteId || !siteId.startsWith('http')) {
            throw new Error('Invalid API_TOKEN or SITE_ID');
        }

        // Get access token
        const accessToken = await getAccessToken(apiToken);

        // Fetch all products (handles version switching automatically)
        const { products, version } = await fetchAllProducts(accessToken);

        logger.info(`Fetched ${products.length} raw products from Wix (version ${version})`);

        // Normalize products
        const normalizedProducts = normalizeProducts(products, siteId, version);

        logger.info('Wix handler completed successfully', { 
            totalNormalizedProducts: normalizedProducts.length,
            version 
        });

        return { products: normalizedProducts };

    } catch (error) {
        logger.error(`Wix provider error: ${error.message}`, {
            stack: error.stack,
            responseStatus: error.response?.status,
            responseData: error.response?.data
        });
        throw error;
    }
};

// ====================== HELPER FUNCTIONS ======================

async function getAccessToken(clientId) {
    const tokenUrl = 'https://www.wixapis.com/oauth2/token';
    const payload = { clientId, grantType: 'anonymous' };
    const headers = { 'Content-Type': 'application/json' };

    try {
        const response = await axios.post(tokenUrl, payload, { headers });
        logger.debug('Successfully obtained Wix access token');
        return response.data.access_token;
    } catch (error) {
        logger.error('Failed to obtain Wix access token', { error: error.message });
        throw new Error(`Failed to obtain Wix access token: ${error.message}`);
    }
}

async function fetchAllProducts(accessToken) {
    let version = 'v3';
    let productsUrl = `https://www.wixapis.com/stores/${version}/products/query`;
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
    };

    let allProducts = [];
    let offset = 0;
    const limit = 100;

    logger.debug(`Starting Wix product fetch with version: ${version}`);

    while (true) {
        const queryPayload = {
            query: { paging: { limit, offset } },
            fields: version === 'v3' ? ['DESCRIPTION', 'CURRENCY'] : undefined
        };

        try {
            const response = await axios.post(productsUrl, queryPayload, { headers });
            const products = response.data.products || [];

            logger.info(`Wix page offset ${offset} → ${products.length} products`);
            allProducts = allProducts.concat(products);

            if (products.length < limit) break;

            offset += limit;
        } catch (error) {
            if (error.response && error.response.status === 428) {
                const errorMsg = error.response.data.message || '';
                const match = errorMsg.match(/This site is using CATALOG_(\w+)/i);
                if (match && match[1]) {
                    const newVersion = match[1].toLowerCase();
                    if (newVersion !== version) {
                        version = newVersion;
                        productsUrl = `https://www.wixapis.com/stores/${version}/products/query`;
                        logger.info(`Switching to Wix version: ${version}`);
                        offset = 0;
                        allProducts = [];
                        continue;
                    }
                }
            }
            logger.error('Wix API error', { status: error.response?.status, data: error.response?.data });
            throw new Error(`Failed to fetch Wix products: ${error.message}`);
        }
    }

    return { products: allProducts, version };
}

function extractTextFromNodes(nodes) {
    let text = '';
    if (!nodes || !Array.isArray(nodes)) return text;

    nodes.forEach(node => {
        if (node.type === 'TEXT' && node.textData && node.textData.text) {
            text += node.textData.text;
        } else if (node.nodes && node.nodes.length > 0) {
            text += extractTextFromNodes(node.nodes);
        }
        if (node.type === 'PARAGRAPH') text += '\n';
    });
    return text;
}

function getProductDescription(product, version) {
    let description = '';

    if (version === 'v3') {
        if (product.description && product.description.nodes) {
            description = extractTextFromNodes(product.description.nodes);
        }
        if (!description) {
            description = product.name || product.slug || 'No description available';
        }
    } else {
        description = product.description || product.name || 'No description available';
    }

    return description.trim();
}

function normalizeProducts(rawProducts, siteId, version) {
    return rawProducts
        .filter(product => product.id && (product.name || product.slug))
        .map(product => {
            let originalPrice = 0;
            let discountedPrice = 0;

            if (version === 'v3') {
                const minActual = parseFloat(product.actualPriceRange?.minValue?.amount) || 0;
                const minCompare = parseFloat(product.compareAtPriceRange?.minValue?.amount) || 0;
                originalPrice = minCompare > 0 ? minCompare : minActual;
                discountedPrice = minActual;
            } else {
                const priceData = product.price || {};
                originalPrice = parseFloat(priceData.price) || 0;
                discountedPrice = parseFloat(priceData.discountedPrice) || originalPrice;
            }

            const currency = product.currency || (product.price && product.price.currency) || 'USD';

            const description = getProductDescription(product, version);
            const specifications = version === 'v3' ? '' : (product.specifications || '');

            const categoryName = version === 'v3' 
                ? (product.category || '') 
                : (product.categories && product.categories[0] ? product.categories[0].name : '');

            const sku = product.sku || '';
            const brand = product.brand || '';

            let mainImageUrl = '';
            if (version === 'v3') {
                mainImageUrl = product.media?.main?.image?.url || product.media?.main?.url || '';
                if (!mainImageUrl && product.media?.items?.length) {
                    mainImageUrl = product.media.items[0].image?.url || product.media.items[0].url || '';
                }
            } else {
                mainImageUrl = product.media?.[0]?.url || '';
            }

            const affiliatePath = product.slug 
                ? `${siteId}/${product.slug}` 
                : (product.permalink || '');

            const categoryId = version === 'v3' 
                ? (product.collectionIds?.[0] || '') 
                : (product.categories?.[0]?.id?.toString() || '');

            const category = categoryName;
            const subcategory = '';

            return {
                id: product.id || '',
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
        });
}