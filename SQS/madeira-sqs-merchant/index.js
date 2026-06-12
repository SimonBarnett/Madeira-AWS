// index.js - FULL PRODUCTION VERSION
// Central orchestrator for merchant product synchronization pipeline

const {
  sql,
  logger,
  getDbPool,
  getS3Client,
  getSQSClient,
  SendMessageCommand,
  PutObjectCommand,
  GetObjectCommand,
  enqueueMessage,
  executeWithRetry
} = require('/opt/nodejs/helpers');

// ====================== S3 / SQS CONFIG ======================
const S3_BUCKET = process.env.S3_RESULTS_BUCKET;
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL;

// ====================== SAFE CONFIGURATION ======================
function getEnvInt(key, defaultValue, minValue = 1) {
  const raw = process.env[key];
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < minValue) {
    if (raw !== undefined && raw !== '') {
      logger.warn(`Invalid value for ${key}="${raw}". Using default: ${defaultValue}`);
    }
    return defaultValue;
  }
  return parsed;
}

const DB_BATCH_SIZE = getEnvInt('DB_BATCH_SIZE', 3500, 500);
const MIN_AGE_HOURS = getEnvInt('MIN_AGE_HOURS', 48, 1);
const MERGE_BATCH_ENQUEUE_DELAY_MS = getEnvInt('MERGE_BATCH_ENQUEUE_DELAY_MS', 120, 0);

logger.info('Configuration loaded', {
  DB_BATCH_SIZE,
  MIN_AGE_HOURS,
  MERGE_BATCH_ENQUEUE_DELAY_MS
});

// ====================== PROVIDER HANDLERS ======================
const providers = {
  wixStore: require('./routes/wixStore').handler,
  shopify: require('./routes/shopify').handler,
  WooCommerce: require('./routes/wooCommerce').handler,
  magento: require('./routes/magento').handler,
  bigCommerce: require('./routes/bigCommerce').handler,
  awin: require('./routes/awin').handler
};

// ====================== SQS SUB-HANDLERS ======================
const processMerchant = require('./sqs/processMerchant').handler;
const mergeBatch = require('./sqs/mergeBatch').handler;
const finalCleanup = require('./sqs/finalCleanup').handler;

// ====================== INDEX CONTROL (PROTECTED WITH RETRY) ======================
async function runDisableIndexes(pool, sandbox = false) {

  try {
    if (sandbox) {
      logger.info('🔴 Running DisableMerchantIndexes (Sandbox)...');
      await executeWithRetry(
        () => pool.request().query(`
          IF NOT EXISTS (
            SELECT 1 FROM dbo.LASTS 
            WHERE OperationName = 'IndexesBulkLoadDisabled'
          )
          BEGIN
            INSERT INTO dbo.LASTS (OperationName, LastRun)
            VALUES ('IndexesBulkLoadDisabled', GETDATE());
          END
        `),
        { maxRetries: 4, logger }
      );
      logger.info('🧪 SANDBOX: Marked IndexesBulkLoadDisabled in LASTS');
    } else {
      logger.info('🔴 Running DisableMerchantIndexes...');
      await executeWithRetry(
        () => pool.request().query(`EXEC [dbo].[DisableMerchantIndexes];`),
        { maxRetries: 4, logger }
      );
      logger.info('✅ Production: DisableMerchantIndexes executed');
    }
  } catch (err) {
    logger.error('❌ Failed to run DisableMerchantIndexes', { error: err.message });
    throw err;
  }
}

async function runEnableIndexes(pool, sandbox = false) {
  try {
    if (sandbox) {
      logger.info('🟢 Running EnableMerchantIndexes (Sandbox)...');
      await executeWithRetry(
        () => pool.request().query(`
          DELETE FROM dbo.LASTS 
          WHERE OperationName = 'MAINTAINANCE_WINDOW';

          UPDATE dbo.LASTS 
          SET LastRun = GETDATE() 
          WHERE OperationName = 'IndexesBulkLoadDisabled';
        `),
        { maxRetries: 4, logger }
      );
      logger.info('🧪 SANDBOX: Removed MAINTAINANCE_WINDOW and updated index status');
    } else {
      logger.info('🟢 Running EnableMerchantIndexes...');
      await executeWithRetry(
        () => pool.request().query(`EXEC [dbo].[StartAsyncIndexRebuild];`),
        { maxRetries: 4, logger }
      );
      logger.info('✅ Production: StartAsyncIndexRebuild executed');
    }
  } catch (err) {
    logger.error('❌ Failed to run EnableMerchantIndexes', { error: err.message });
    throw err;
  }
}

// ====================== ENQUEUE GLOBAL REBUILD ======================
async function enqueueGlobalRebuild(sandbox = false) {
  await sendToSQS({ type: "GLOBAL_REBUILD", sandbox });
  logger.info('✅ Enqueued GLOBAL_REBUILD');
}

// ====================== MAINTENANCE WINDOW HELPERS (PROTECTED) ======================
async function isMaintenanceWindowActive(pool) {
  const result = await executeWithRetry(
    () => pool.request().query(`
      SELECT COUNT(*) AS ActiveCount
      FROM dbo.LASTS
      WHERE OperationName = 'MAINTAINANCE_WINDOW'
    `),
    { maxRetries: 3, logger }
  );
  return result.recordset[0].ActiveCount > 0;
}

async function startMaintenanceWindow(pool) {
  await executeWithRetry(
    () => pool.request().query(`
      MERGE dbo.LASTS AS target
      USING (SELECT 'MAINTAINANCE_WINDOW' AS OperationName) AS source
      ON target.OperationName = source.OperationName
      WHEN MATCHED THEN 
        UPDATE SET LastRun = GETDATE()
      WHEN NOT MATCHED THEN 
        INSERT (OperationName, LastRun) VALUES (source.OperationName, GETDATE());
    `),
    { maxRetries: 3, logger }
  );
  logger.info('✅ MAINTAINANCE_WINDOW started');
}

// ====================== SQS SEND HELPER ======================
async function sendToSQS(messageBody, messageGroupId = null, messageDeduplicationId = null) {
  if (!SQS_QUEUE_URL) {
    logger.error('❌ SQS_QUEUE_URL is not set');
    throw new Error('SQS_QUEUE_URL not configured');
  }

  const payload = JSON.stringify(messageBody);
  const sqsClient = await getSQSClient();

  const params = {
    QueueUrl: SQS_QUEUE_URL,
    MessageBody: payload
  };

  const isFifoQueue = SQS_QUEUE_URL.endsWith('.fifo');
  if (isFifoQueue && messageGroupId) {
    params.MessageGroupId = messageGroupId;
  }
  if (isFifoQueue && messageDeduplicationId) {
    params.MessageDeduplicationId = messageDeduplicationId;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const command = new SendMessageCommand(params);
      const result = await sqsClient.send(command);
      return result;
    } catch (err) {
      logger.warn(`SQS send attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
  throw new Error('Failed to send message to SQS after 3 attempts');
}

// ====================== ENQUEUE HELPERS ======================
async function enqueueBatchMessages(userApiKeyId, userId, description, source, batchId, totalBatches, s3Keys, sandbox = false) {
  const CONCURRENCY = 8;
  const BREATHING_ROOM_MS = 250;
  const allMessages = [];

  for (let fileIndex = 0; fileIndex < s3Keys.length; fileIndex++) {
    const s3Key = s3Keys[fileIndex];
    const fileBatchNum = fileIndex + 1;

    for (let chunkIndex = 0; chunkIndex < 25; chunkIndex++) {
      const body = {
        type: "MERGE_BATCH",
        userApiKeyId,
        userId,
        description,
        source,
        batchId,
        batchNum: fileBatchNum,
        totalBatches,
        s3Key,
        chunkIndex,
        totalChunks: 25,
        sandbox
      };
      allMessages.push(body);
    }
  }

  const results = [];

  for (let i = 0; i < allMessages.length; i += CONCURRENCY) {
    const chunk = allMessages.slice(i, i + CONCURRENCY);
    const promises = chunk.map(body => sendToSQS(body));
    const chunkResults = await Promise.allSettled(promises);
    results.push(...chunkResults);

    if (i + CONCURRENCY < allMessages.length) {
      await new Promise(r => setTimeout(r, BREATHING_ROOM_MS));
    }
  }

  const successful = results.filter(r => r.status === 'fulfilled').length;
  logger.info(`✅ Enqueued ${successful} MERGE_BATCH messages`);
}

async function enqueueMerchantIds(ids, sandbox = false) {
  const promises = ids.map(id =>
    sendToSQS({ type: "PROCESS_MERCHANT", userApiKeyId: id, sandbox })
  );
  await Promise.all(promises);
  logger.info(`✅ Enqueued ${ids.length} merchants`);
}

// ====================== S3 HELPERS ======================
async function uploadBatchToS3(batchId, batchNum, totalBatches, products) {
  const key = `merchant-batches/${batchId}/batch-${String(batchNum).padStart(4, '0')}.json`;
  const s3Client = await getS3Client();

  await s3Client.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: JSON.stringify(products),
    ContentType: 'application/json'
  }));

  logger.info(`✅ Uploaded batch ${batchNum} → ${key} (${products.length} products)`);
  return key;
}

async function downloadBatchFromS3(s3Key) {
  const s3Client = await getS3Client();
  const res = await s3Client.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }));
  return JSON.parse(await res.Body.transformToString());
}

// ====================== STATUS UPDATE ======================
async function updateApiKeyStatus(executor, userId, description, source, statusCode, options = {}) {
  const { errorMessage = null, totalParts = null, inserted = null, updated = null, deleted = null } = options;

  try {
    let query = `
      UPDATE UserApiKeys
      SET LastStatus = @lastStatus,
          LastError = @lastError,
          updated_at = GETDATE()
    `;

    const inputs = [
      { name: 'userId', type: sql.VarChar, value: userId },
      { name: 'description', type: sql.VarChar, value: description },
      { name: 'apiKeyType', type: sql.VarChar, value: source },
      { name: 'lastStatus', type: sql.Int, value: statusCode },
      { name: 'lastError', type: sql.NVarChar(sql.MAX), value: errorMessage }
    ];

    if (totalParts !== null) {
      query += `, TotalParts = @totalParts`;
      inputs.push({ name: 'totalParts', type: sql.Int, value: totalParts });
    }
    if (inserted !== null) {
      query += `, count_inserted = @inserted`;
      inputs.push({ name: 'inserted', type: sql.Int, value: inserted });
    }
    if (updated !== null) {
      query += `, count_updated = @updated`;
      inputs.push({ name: 'updated', type: sql.Int, value: updated });
    }

    query += `
      WHERE user_id = @userId 
        AND Description = @description 
        AND api_key_type = @apiKeyType;
    `;

    const request = executor.request();
    inputs.forEach(inp => request.input(inp.name, inp.type, inp.value));
    await request.query(query);
  } catch (e) {
    logger.error(`Failed to update status for ${userId} / ${source}: ${e.message}`);
  }
}

async function isIndexesBulkLoadDisabled(pool, isSandbox) {
  
  const result = await pool.request()
    .query(`
      SELECT TOP 1 1 
      FROM LASTS
      WHERE [OperationName] = 'IndexesBulkLoadDisabled'
    `);

  return result.recordset.length > 0;
}

// ====================== CONTEXT ======================
const createHandlerContext = (pool, lambdaContext = null) => ({
  providers,
  uploadBatchToS3,
  downloadBatchFromS3,
  enqueueBatchMessages,
  updateApiKeyStatus,
  enqueueGlobalRebuild,
  enqueueMerchantIds,
  enqueueMessage,
  DB_BATCH_SIZE,
  MIN_AGE_HOURS,
  logger,
  sql,
  pool,
  context: lambdaContext
});

// ====================== MAIN HANDLER ======================
exports.handler = async (event, context) => {
  let pool = null;

  try {
    pool = await getDbPool();

    const msg = event.Records ? JSON.parse(event.Records[0].body) : event;
    if (msg.type) logger.info(`📨 Received message type: ${msg.type}`);

    const handlerContext = createHandlerContext(pool, context);
    const isSandbox = msg.sandbox === true;

    const inMaintenanceWindow = await isMaintenanceWindowActive(pool);

    // ====================== GLOBAL GATE: MAINTAINANCE_WINDOW ======================
    if (msg.type !== "MAINTAINANCE_WINDOW") {
      if (!inMaintenanceWindow) {
        logger.warn(`⚠️ Processing blocked. No MAINTAINANCE_WINDOW active.`);
        return {
          statusCode: 403,
          body: JSON.stringify({ message: 'Processing only allowed during MAINTAINANCE_WINDOW.' })
        };
      }
    }

    // ====================== START MAINTENANCE WINDOW ======================
    if (msg.type === "MAINTAINANCE_WINDOW") {
      if (inMaintenanceWindow) {
        logger.warn(`⚠️ MAINTAINANCE_WINDOW already active.`);
        return {
          statusCode: 403,
          body: JSON.stringify({ message: 'MAINTAINANCE_WINDOW active.' })
        };
      }

      try {
        await startMaintenanceWindow(pool);
        await runDisableIndexes(pool, isSandbox);

        await enqueueMessage({
          type: "WAIT_INDEX",
          sandbox: isSandbox
        });

        logger.info("✅ MAINTAINANCE_WINDOW started. Enqueued WAIT_INDEX to verify indexes are disabled.");

        return {
          statusCode: 200,
          body: JSON.stringify({ message: 'MAINTAINANCE_WINDOW started' })
        };

      } catch (err) {
        logger.error("Failed to start MAINTAINANCE_WINDOW", { error: err.message });

        return {
          statusCode: 500,
          body: JSON.stringify({
            message: "Failed to start MAINTAINANCE_WINDOW",
            error: err.message
          })
        };
      }
    }

    // ====================== SCHEDULED INVOCATION ======================
    if (!event.Records) {
      return await processMerchant(msg, pool, handlerContext);
    }

    // ====================== SQS MESSAGE HANDLING ======================
    if (msg.type === "GLOBAL_REBUILD") {
      return await runEnableIndexes(pool, isSandbox);
    }

    if (msg.type === "PROCESS_MERCHANT") {
      return await processMerchant(msg, pool, handlerContext);
    }

    if (msg.type === "MERGE_BATCH") {
      return await mergeBatch(msg, handlerContext);
    }

    if (msg.type === "FINAL_CLEANUP") {
      return await finalCleanup(msg, handlerContext);
    }
    
    if (msg.type === "WAIT_INDEX") {
      const { sandbox } = msg;
      const isSandbox = sandbox === true;
    
      logger.info("🔍 WAIT_INDEX: Checking if IndexesBulkLoadDisabled flag exists...");
    
      const isDisabled = await isIndexesBulkLoadDisabled(pool, isSandbox);
    
      if (isDisabled) {
        logger.info("✅ IndexesBulkLoadDisabled found in LASTS. Starting merchant processing.");
    
        await enqueueMessage({
          type: "PROCESS_MERCHANT",
          lastId: 0,
          sandbox: isSandbox
        });
    
        return {
          statusCode: 200,
          body: JSON.stringify({ message: 'Indexes disabled. Processing started.' })
        };
      }
    
      // Flag not present yet → retry
      logger.warn("⏳ IndexesBulkLoadDisabled not found yet. Re-running disableIndexes...");
    
      try {
        await runDisableIndexes(pool, isSandbox);
      } catch (err) {
        logger.error("Failed to re-run runDisableIndexes", { error: err.message });
      }
    
      // Re-enqueue WAIT_INDEX with delay
      await enqueueMessage(
        {
          type: "WAIT_INDEX",
          sandbox: isSandbox
        },
        { delaySeconds: 20 }
      );
    
      return {
        statusCode: 200,                    // ← Changed from 300
        body: JSON.stringify({ message: 'Waiting for indexes to be disabled...' })
      };
    }

    return { statusCode: 400, body: 'Unknown message type' };

  } catch (error) {
    logger.error(`Processing failed: ${error.message}`);
    throw error;
  }
};

module.exports = { handler: exports.handler };