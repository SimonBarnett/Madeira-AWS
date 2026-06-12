// sqs/mergeBatch.js - SEQUENTIAL CHAINING VERSION
const { sql, logger, getDbPool, getS3Client, GetObjectCommand, executeWithRetry } = require('/opt/nodejs/helpers');

const MERGE_CHUNK_SIZE = 100;

module.exports = {
  handler: async (msg, context = {}) => {
    const {
      userId,
      description,
      source,
      batchId,
      fileIndex = 0,
      chunkIndex = 0,
      totalFiles = 1,
      s3Keys = [],
      s3Key,
      lastId,
      sandbox,
      manual
    } = msg;

    const isSandbox = sandbox === true;
    const handlerStartTime = Date.now();

    logger.info(`🧩 MERGE_BATCH started`, {
      userId,
      fileIndex,
      chunkIndex,
      totalFiles,
      lastId,
      sandbox: isSandbox
    });

    let pool = null;

    try {
      pool = await getDbPool();

      if (!pool || typeof pool.request !== 'function') {
        throw new Error('Database pool is not available or invalid');
      }

      // === Download from S3 ===
      const s3Start = Date.now();
      const products = await downloadBatchFromS3Internal(s3Key);
      const s3Duration = Date.now() - s3Start;

      logger.info(`📦 Downloaded ${products.length} products from S3`, {
        userId,
        s3Key,
        durationMs: s3Duration
      });

      const startIdx = chunkIndex * MERGE_CHUNK_SIZE;
      const endIdx = Math.min(startIdx + MERGE_CHUNK_SIZE, products.length);
      const chunk = products.slice(startIdx, endIdx);

      if (chunk.length === 0) {
        logger.warn(`Chunk ${chunkIndex} is empty — skipping`);
        await chainNextMergeOrCleanup({ ...msg, chunkSize: 0 }, context);
        return { statusCode: 200 };
      }

      if (chunkIndex === 0) {
        logger.info(`🔍 FIRST PRODUCT KEYS → ${Object.keys(chunk[0] || {})}`);
        logger.info(`🔍 FIRST PRODUCT SAMPLE →`, chunk[0]);
      }

      logger.info(`→ Processing chunk ${chunkIndex + 1} of file ${fileIndex + 1}/${totalFiles} (${chunk.length} products)`);

      // === Execute MERGE with retry ===
      const mergeResult = await executeWithRetry(
        () => processSingleChunk(pool, chunk, userId, source, batchId),
        { maxRetries: 5, logger }
      );

      const totalDuration = Date.now() - handlerStartTime;

      logger.info(`✅ MERGE chunk completed`, {
        userId,
        fileIndex,
        chunkIndex,
        inserted: mergeResult.inserted,
        updated: mergeResult.updated,
        mergeDurationMs: mergeResult.mergeDurationMs,
        retryCount: mergeResult.retryCount || 0,
        totalHandlerDurationMs: totalDuration
      });

      // === Chain to next step ===
      await chainNextMergeOrCleanup({ ...msg, chunkSize: chunk.length }, context);

      return { statusCode: 200 };

    } catch (err) {
      logger.error(`❌ MERGE_BATCH failed`, {
        userId,
        fileIndex,
        chunkIndex,
        batchId,
        error: err.message,
        code: err.code || err.number
      });

      if (pool && context.updateApiKeyStatus) {
        try {
          await context.updateApiKeyStatus(pool, userId, description, source, 500, {
            errorMessage: `MERGE_BATCH failed: ${err.message}`
          });
        } catch (_) {}
      }

      throw err;
    } finally {
      logger.debug(`Connection returned to shared mssql pool (file ${fileIndex}, chunk ${chunkIndex})`);
    }
  }
};

// ====================== CHAINING LOGIC ======================
async function chainNextMergeOrCleanup(msg, context) {
  const { enqueueMessage } = context;

  const {
    userId,
    description,
    source,
    batchId,
    fileIndex = 0,
    chunkIndex = 0,
    totalFiles = 1,
    s3Keys = [],
    s3Key,
    lastId,
    sandbox,
    manual,
    chunkSize = 0
  } = msg;

  const isLastFile = (fileIndex + 1) >= totalFiles;
  const isLastChunkOfFile = chunkSize < MERGE_CHUNK_SIZE;

  try {
    if (!isLastChunkOfFile) {
      const nextChunkIndex = chunkIndex + 1;

      await enqueueMessage({
        type: "MERGE_BATCH",
        userId,
        description,
        source,
        batchId,
        fileIndex,
        chunkIndex: nextChunkIndex,
        totalFiles,
        s3Keys,
        s3Key: s3Keys[fileIndex] || s3Key,
        lastId,
        sandbox,
        manual
      });

      logger.info(`➡️ Enqueued next MERGE_BATCH chunk ${nextChunkIndex + 1}`);
    } 
    else if (!isLastFile) {
      const nextFileIndex = fileIndex + 1;
      const nextS3Key = s3Keys[nextFileIndex];

      await enqueueMessage({
        type: "MERGE_BATCH",
        userId,
        description,
        source,
        batchId,
        fileIndex: nextFileIndex,
        chunkIndex: 0,
        totalFiles,
        s3Keys,
        s3Key: nextS3Key,
        lastId,
        sandbox,
        manual
      });

      logger.info(`➡️ Finished file ${fileIndex + 1}. Enqueued first chunk of file ${nextFileIndex + 1}`);
    } 
    else {
      await enqueueMessage({
        type: "FINAL_CLEANUP",
        userId,
        description,
        source,
        batchId,
        lastId,
        sandbox,
        manual
      });

      logger.info(`✅ All chunks and files completed. Enqueued FINAL_CLEANUP`);
    }
  } catch (err) {
    logger.error(`❌ Failed to enqueue next step: ${err.message}`);
    throw err;
  }
}

// ====================== MERGE LOGIC (CORRECTED) ======================
async function processSingleChunk(pool, chunk, userId, source, batchId) {
  const mergeStart = Date.now();

  const result = await pool.request()
    .input('userId', sql.VarChar, userId)
    .input('source', sql.VarChar, source)
    .input('batchId', sql.NVarChar, batchId)
    .input('batchJson', sql.NVarChar(sql.MAX), JSON.stringify(chunk))
    .query(`
      DECLARE @SourceData TABLE (
          id NVARCHAR(128), name NVARCHAR(500), price NVARCHAR(50),
          affiliatePath NVARCHAR(2048), mainImageUrl NVARCHAR(2048),
          category NVARCHAR(255), subcategory NVARCHAR(255), brand NVARCHAR(255)
      );

      INSERT INTO @SourceData (id, name, price, affiliatePath, mainImageUrl, category, subcategory, brand)
      SELECT id, name, price, affiliatePath, mainImageUrl, category, subcategory, brand
      FROM OPENJSON(@batchJson)
      WITH (
          id NVARCHAR(128) '$.id',
          name NVARCHAR(500) '$.name',
          price NVARCHAR(50) '$.price',
          affiliatePath NVARCHAR(2048) '$.affiliatePath',
          mainImageUrl NVARCHAR(2048) '$.mainImageUrl',
          category NVARCHAR(255) '$.category',
          subcategory NVARCHAR(255) '$.subcategory',
          brand NVARCHAR(255) '$.brand'
      );

      DECLARE @Actions TABLE (ActionType NVARCHAR(10));

      MERGE INTO MerchantProducts AS target
      USING @SourceData AS source
      ON target.UserId = @userId 
         AND target.Source = @source 
         AND target.ASIN = source.id

      WHEN MATCHED THEN
          UPDATE SET 
              target.Title = source.name,
              target.Price = source.price,
              target.AffiliateUrl = source.affiliatePath,
              target.ThumbnailUrl = source.mainImageUrl,
              target.CategoryName = source.category,
              target.Subcategory = source.subcategory,
              target.Brand = source.brand,
              target.LastUpdate = GETDATE(),
              target.ProcessedBatchId = @batchId

      WHEN NOT MATCHED THEN
          INSERT (UserId, Source, ASIN, Title, Price, AffiliateUrl, ThumbnailUrl, 
                  CategoryName, Subcategory, Brand, ProcessedBatchId, LastUpdate)
          VALUES (@userId, @source, source.id, source.name, source.price, source.affiliatePath,
                  source.mainImageUrl, source.category, source.subcategory, source.brand, 
                  @batchId, GETDATE())

      OUTPUT $action INTO @Actions;

      SELECT 
          COUNT(CASE WHEN ActionType = 'INSERT' THEN 1 END) AS Inserted,
          COUNT(CASE WHEN ActionType = 'UPDATE' THEN 1 END) AS Updated
      FROM @Actions;
    `);

  const mergeDurationMs = Date.now() - mergeStart;
  const record = result.recordset?.[0] || {};

  return {
    inserted: record.Inserted || 0,
    updated: record.Updated || 0,
    mergeDurationMs
  };
}

// ====================== S3 HELPERS ======================
async function downloadBatchFromS3Internal(s3Key) {
  const s3Client = await getS3Client();
  const response = await s3Client.send(new GetObjectCommand({
    Bucket: process.env.S3_RESULTS_BUCKET,
    Key: s3Key
  }));
  const body = await streamToString(response.Body);
  return JSON.parse(body);
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}