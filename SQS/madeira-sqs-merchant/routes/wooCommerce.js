const axios = require('axios');
const { logger } = require('/opt/nodejs/helpers');

async function fetchCurrency(baseUrl) {
  try {
    const url = new URL(baseUrl);
    const response = await axios.get(`${url.origin}/wp-json/wc/v3/settings/general`, { timeout: 10000 });
    const currencySetting = response.data.find(s => s.id === 'woocommerce_currency');
    return currencySetting ? currencySetting.value : 'GBP';
  } catch {
    logger.warn(`Could not fetch currency, defaulting to GBP`);
    return 'GBP';
  }
}

async function fetchAllProducts(event) {
  const { apiKeyData } = event;
  const { baseUrl, consumerKey, consumerSecret } = apiKeyData;

  logger.info('Starting WooCommerce handler', { baseUrl });

  const currency = await fetchCurrency(baseUrl);

  let allProducts = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = new URL(baseUrl);
    const apiUrl = `${url.origin}/wp-json/wc/v3/products`;

    const response = await axios.get(apiUrl, {
      auth: { username: consumerKey, password: consumerSecret },
      params: { per_page: perPage, page, status: 'publish' },
      timeout: 15000
    });

    const products = response.data || [];
    if (products.length === 0) break;

    const normalized = products.map(p => ({
      id: p.id.toString(),
      name: p.name,
      originalPrice: parseFloat(p.regular_price || p.price || 0),
      discountedPrice: parseFloat(p.sale_price || p.price || 0),
      currency,
      description: p.short_description || p.description || '',
      category: p.categories?.[0]?.name || '',
      sku: p.sku || '',
      mainImageUrl: p.images?.[0]?.src || '',
      affiliatePath: p.permalink || '',
      hasWidget: true
    }));

    allProducts = allProducts.concat(normalized);
    page++;
    if (products.length < perPage) break;
  }

  logger.info(`WooCommerce handler completed successfully`, { totalNormalizedProducts: allProducts.length });
  return { products: allProducts };
}

exports.handler = fetchAllProducts;