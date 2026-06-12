// sqs/processMerchant.js
const { v4: uuidv4 } = require('uuid');
const { logger, executeWithRetry } = require('/opt/nodejs/helpers');
const { getEligibleMerchants } = require('../merchantEligibility');

module.exports = {
  handler: async (msg, pool, context) => {
    const { 
      lastId = 0, 
      userApiKeyId: manualUserApiKeyId, 
      manual, 
      sandbox 
    } = msg;

    const isSandbox = sandbox === true;
    const isManual = !!manualUserApiKeyId;

    const { 
      providers, 
      uploadBatchToS3, 
      DB_BATCH_SIZE, 
      MIN_AGE_HOURS, 
      updateApiKeyStatus, 
      enqueueMessage
    } = context;

    if (isManual) {
      logger.info(`📌 Manual single merchant test - processing ONLY ID ${manualUserApiKeyId}`);
    } else {
      logger.info(`🔄 Sequential processing started (LastID: ${lastId})`);
    }

    let userApiKeyId, userId, description, source;

    try {
      if (!pool || typeof pool.request !== 'function') {
        throw new Error('Invalid DB pool');
      }

      let merchant = null;

      if (isManual && manualUserApiKeyId) {
        const res = await executeWithRetry(
          () => pool.request()
            .input('id', require('mssql').Int, manualUserApiKeyId)
            .query(`SELECT Id, user_id, Description, api_key_type FROM UserApiKeys WHERE Id = @id`),
          { maxRetries: 3, logger }
        );
        merchant = res.recordset[0] || null;
      } else {
        merchant = await getEligibleMerchants(pool, {
          lastId,
          minAgeHours: MIN_AGE_HOURS,
          sandbox: isSandbox
        });
      }

      if (!merchant) {
        logger.info('✅ No more eligible merchants to start.');

        // GLOBAL_REBUILD is triggered ONLY from here.
        // This guarantees it fires once, at the very end, after all in-flight work has drained.
        if (!isManual && typeof enqueueMessage === 'function') {
          logger.info('✅ All merchants have been fully processed. Triggering GLOBAL_REBUILD');
          await enqueueMessage({
            type: "GLOBAL_REBUILD",
            sandbox: isSandbox
          });
        }

        return { statusCode: 200, body: 'No more merchants to start' };
      }

      userApiKeyId = merchant.Id;
      userId = merchant.user_id;
      description = merchant.Description;
      source = merchant.api_key_type;

      await updateApiKeyStatus(pool, userId, description, source, 100, {
        errorMessage: 'Processing started'
      });

      // ====================== LOOKUP + BATCH ID ======================
      const lookup = await executeWithRetry(
        () => pool.request()
          .input('id', require('mssql').Int, userApiKeyId)
          .query(`SELECT user_id, Description, api_key_type, api_key_data FROM UserApiKeys WHERE Id = @id`),
        { maxRetries: 3, logger }
      );

      if (lookup.recordset.length === 0) {
        throw new Error(`API key ${userApiKeyId} not found`);
      }

      const row = lookup.recordset[0];
      const apiKeyData = JSON.parse(row.api_key_data || '{}');

      let batchId;

      const existingBatch = await executeWithRetry(
        () => pool.request()
          .input('userId', require('mssql').VarChar, userId)
          .input('source', require('mssql').VarChar, source)
          .query(`
            SELECT CurrentBatchId FROM UserApiKeys 
            WHERE user_id = @userId AND api_key_type = @source 
              AND CurrentBatchId IS NOT NULL AND BatchStartedAt > DATEADD(minute, -60, GETDATE())
          `),
        { maxRetries: 3, logger }
      );

      if (existingBatch.recordset.length > 0) {
        batchId = existingBatch.recordset[0].CurrentBatchId;
        await executeWithRetry(
          () => pool.request()
            .input('userId', require('mssql').VarChar, userId)
            .input('source', require('mssql').VarChar, source)
            .input('batchId', require('mssql').NVarChar, batchId)
            .query(`UPDATE UserApiKeys SET BatchStartedAt = GETDATE() WHERE user_id = @userId AND api_key_type = @source AND CurrentBatchId = @batchId`),
          { maxRetries: 3, logger }
        );
      } else {
        batchId = uuidv4();
        await executeWithRetry(
          () => pool.request()
            .input('userId', require('mssql').VarChar, userId)
            .input('source', require('mssql').VarChar, source)
            .input('batchId', require('mssql').NVarChar, batchId)
            .query(`UPDATE UserApiKeys SET CurrentBatchId = @batchId, BatchStartedAt = GETDATE() WHERE user_id = @userId AND api_key_type = @source`),
          { maxRetries: 3, logger }
        );
      }

      // ====================== PROVIDER + S3 UPLOAD ======================
      const providerKey = source === 'BigCommerce' ? 'bigCommerce' : source;
      const providerHandler = providers[providerKey];

      if (!providerHandler) {
        throw new Error(`Unsupported provider: ${source}`);
      }

      const s3Keys = [];
      let totalProducts = 0;
      const isAwin = source.toLowerCase() === 'awin';

      try {
        if (isAwin) {
          await providerHandler({ apiKeyData }, async (batch) => {
            if (!batch?.length) return;
            totalProducts += batch.length;
            const s3Key = await uploadBatchToS3(batchId, s3Keys.length + 1, null, batch);
            s3Keys.push(s3Key);
          }, DB_BATCH_SIZE);
        } else {
          const { products } = await providerHandler({ apiKeyData });
          totalProducts = products.length;

          if (totalProducts === 0) {
            await updateApiKeyStatus(pool, userId, description, source, 200, { 
              errorMessage: 'No products found' 
            });
            return { statusCode: 200, body: 'No products' };
          }

          for (let i = 0; i < products.length; i += DB_BATCH_SIZE) {
            const batch = products.slice(i, i + DB_BATCH_SIZE);
            const batchNum = Math.floor(i / DB_BATCH_SIZE) + 1;
            const s3Key = await uploadBatchToS3(batchId, batchNum, Math.ceil(totalProducts / DB_BATCH_SIZE), batch);
            s3Keys.push(s3Key);
          }
        }
      } catch (providerErr) {
        logger.error(`❌ Provider error for ${source} (merchant ${userApiKeyId}): ${providerErr.message}`);
        throw providerErr;
      }

      if (s3Keys.length === 0) {
        await updateApiKeyStatus(pool, userId, description, source, 200, { 
          errorMessage: 'No products found' 
        });
        return { statusCode: 200, body: 'No products' };
      }

      await updateApiKeyStatus(pool, userId, description, source, 100, {
        totalParts: s3Keys.length,
        errorMessage: `Split into ${s3Keys.length} parts (${totalProducts} products)`
      });

      const firstS3Key = s3Keys[0];

      await enqueueMessage({
        type: "MERGE_BATCH",
        userId,
        description,
        source,
        batchId,
        fileIndex: 0,
        chunkIndex: 0,
        totalFiles: s3Keys.length,
        s3Keys: s3Keys,
        s3Key: firstS3Key,
        lastId: userApiKeyId,
        sandbox: isSandbox,
        manual: isManual
      });

      logger.info(`✅ Enqueued first MERGE_BATCH for merchant ${userApiKeyId}${isManual ? ' (manual mode)' : ''}`);

      return { statusCode: 200, body: 'Merchant processed' };

    } catch (err) {
      logger.error(`❌ Error in processMerchant: ${err.message}`);

      if (userId && description && source) {
        try {
          await updateApiKeyStatus(pool, userId, description, source, 500, { 
            errorMessage: err.message 
          });
        } catch (_) {}
      }

      if (userApiKeyId && typeof enqueueMessage === 'function') {
        logger.warn(`⚠️ Merchant ${userApiKeyId} failed. Skipping and continuing to next merchant...`);

        try {
          await enqueueMessage({
            type: "PROCESS_MERCHANT",
            lastId: userApiKeyId,
            sandbox: isSandbox,
            manual: isManual
          });
        } catch (enqueueErr) {
          logger.error(`❌ Failed to enqueue next PROCESS_MERCHANT: ${enqueueErr.message}`);
        }
      }

      return { 
        statusCode: 200, 
        body: `Merchant processing failed but chain continued: ${err.message}` 
      };
    }
  }
};