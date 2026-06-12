// routes/awin.js - STREAMING + LOW MEMORY VERSION (CORRECT MAPPING)
// Fully mapped to match mergeBatch.js OPENJSON expectations
// Last updated: 06 June 2026

const fetch = require('node-fetch');
const zlib = require('zlib');
const { logger } = require('/opt/nodejs/helpers');

/**
 * Robust CSV line parser (handles quoted fields with commas)
 */
function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (char === '"' && !inQuotes) {
      inQuotes = true;
    } else if (char === '"' && inQuotes) {
      if (line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = false;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
    i++;
  }
  values.push(current);
  return values;
}

/**
 * Safe string extractor with multiple possible column names
 */
function getField(item, ...possibleKeys) {
  for (const key of possibleKeys) {
    if (item[key] !== undefined && item[key] !== '') {
      return String(item[key]).trim();
    }
  }
  return '';
}

exports.handler = async (event, onBatch, batchSize = 1500) => {
  const startTime = Date.now();
  const { apiKeyData } = event;

  if (!apiKeyData || !apiKeyData.feedUrl) {
    throw new Error('Missing feedUrl in apiKeyData');
  }

  const feedUrl = apiKeyData.feedUrl;
  logger.info(`🚀 [Awin] Starting streaming feed download for ${feedUrl}`);

  let response;
  try {
    response = await fetch(feedUrl, {
      headers: { 'User-Agent': 'Madeira-Merchant-Awin-Feed/1.0' }
    });
    if (!response.ok) {
      throw new Error(`Awin feed failed: HTTP ${response.status}`);
    }
  } catch (err) {
    logger.error(`❌ [Awin] Fetch failed: ${err.message}`);
    throw err;
  }

  const gunzip = zlib.createGunzip();
  const stream = response.body.pipe(gunzip);

  let lineBuffer = '';
  let lineCount = 0;
  let headers = null;
  let currentBatch = [];

  try {
    for await (const chunk of stream) {
      lineBuffer += chunk.toString('utf8');
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        lineCount++;

        if (!headers) {
          headers = trimmed.split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
          logger.info(`✅ [Awin] Headers parsed - ${headers.length} columns`);
          continue;
        }

        const values = parseCSVLine(trimmed);
        if (values.length < headers.length) continue;

        const item = {};
        headers.forEach((header, index) => {
          item[header] = values[index] || '';
        });

        // ====================== CORRECT MAPPING ======================
        const product = {
          id: getField(item, 'aw_product_id', 'merchant_product_id', 'product_id', 'id').slice(0, 128),
          name: getField(item, 'product_name', 'title', 'name').slice(0, 500),
          price: (() => {
            let priceStr = getField(item, 'search_price', 'store_price', 'display_price', 'price', 'sale_price');
            priceStr = priceStr.replace(/[^0-9.]/g, '');
            const priceNum = parseFloat(priceStr) || 0;
            return `£${priceNum.toFixed(2)}`;
          })(),
          affiliatePath: getField(item, 
            'aw_deep_link', 
            'merchant_deep_link', 
            'deep_link', 
            'deeplink', 
            'link', 
            'product_url', 
            'aw_link', 
            'url'
          ).slice(0, 2048),
          mainImageUrl: getField(item, 'aw_image_url', 'merchant_image_url', 'image_url', 'thumbnail').slice(0, 2048),
          category: getField(item, 'merchant_category', 'category', 'category_name').slice(0, 255),
          subcategory: getField(item, 'subcategory', 'sub_category').slice(0, 255),
          brand: getField(item, 'brand', 'brand_name', 'manufacturer').slice(0, 128)
        };

        // ====================== IMPROVED FILTERING ======================
        // Require id + name. affiliatePath is preferred but not mandatory
        if (product.id && product.name) {
          currentBatch.push(product);

          if (currentBatch.length >= batchSize) {
            await onBatch(currentBatch);
            currentBatch = []; // free memory immediately
          }
        } else {
          // Log skipped rows for debugging (first 50 rows)
          if (lineCount <= 50) {
            logger.warn(`⚠️ [Awin] Skipped row ${lineCount} - missing required fields`, {
              id: product.id,
              name: product.name,
              affiliatePath: product.affiliatePath,
              availableColumns: Object.keys(item).slice(0, 20)
            });
          }
        }
      }
    }

    // Send any remaining products
    if (currentBatch.length > 0) {
      await onBatch(currentBatch);
    }

  } catch (err) {
    logger.error(`❌ [Awin] Streaming error: ${err.message}`);
    throw err;
  }

  const duration = Math.round((Date.now() - startTime) / 1000);
  logger.info(`✅ [Awin] Streaming complete - ${lineCount} lines processed in ${duration}s`);
};