// sqs/finalCleanup.js - SEQUENTIAL CHAINING VERSION
const { sql, logger, getDbPool, executeWithRetry } = require('/opt/nodejs/helpers');
const { getEligibleMerchants } = require('../merchantEligibility');

module.exports = {
  handler: async (msg, context = {}) => {
    const { userId, description, source, batchId, lastId, sandbox, manual, MIN_AGE_HOURS } = msg;
    const isSandbox = sandbox === true;
    const startTime = Date.now();

    logger.info(`🏁 FINAL_CLEANUP started for user ${userId} (${description || 'N/A'})${isSandbox ? ' (SANDBOX)' : ''}`);

    let pool = null;
    let tx = null;

    try {
      pool = await getDbPool();

      if (!pool || typeof pool.request !== 'function') {
        throw new Error('Database pool is not available');
      }

      if (context.updateApiKeyStatus) {
        await context.updateApiKeyStatus(pool, userId, description, source, 100, {
          errorMessage: 'Final cleanup – removing stale records...'
        });
      }

      // ====================== AGGRESSIVE BATCHED DELETE ======================
      const deleteResult = await executeWithRetry(
        async () => {
          if (tx) {
            try { await tx.rollback(); } catch (_) {}
          }

          tx = new sql.Transaction(pool);
          await tx.begin();

          let totalDeleted = 0;
          const BATCH_SIZE = 5000;

          while (true) {
            const result = await tx.request()
              .input('userId', sql.VarChar, userId)
              .input('source', sql.VarChar, source)
              .input('batchId', sql.NVarChar, batchId)
              .input('batchSize', sql.Int, BATCH_SIZE)
              .query(`
                DELETE TOP (@batchSize) FROM MerchantProducts WITH (ROWLOCK)
                WHERE UserId = @userId 
                  AND Source = @source 
                  AND ProcessedBatchId != @batchId
                OPTION (RECOMPILE);

                SELECT @@ROWCOUNT AS DeletedRows;
              `);

            const deletedThisBatch = result.recordset[0]?.DeletedRows || 0;
            totalDeleted += deletedThisBatch;

            if (deletedThisBatch < BATCH_SIZE) break;
          }

          await tx.commit();
          return { deletedRows: totalDeleted };
        },
        { maxRetries: 5, logger }
      );

      const deletedRows = deleteResult.deletedRows || 0;

      // ====================== GET STATS ======================
      let inserted = 0;
      let updated = 0;

      try {
        const statsResult = await pool.request()
          .input('userId', sql.VarChar, userId)
          .input('source', sql.VarChar, source)
          .input('batchId', sql.NVarChar, batchId)
          .query(`
            SELECT 
              COUNT(CASE WHEN Created >= DATEADD(minute, -45, GETDATE()) THEN 1 END) AS Inserted,
              COUNT(CASE WHEN LastUpdate >= DATEADD(minute, -45, GETDATE()) 
                         AND Created < DATEADD(minute, -45, GETDATE()) THEN 1 END) AS Updated
            FROM MerchantProducts
            WHERE UserId = @userId 
              AND Source = @source 
              AND ProcessedBatchId = @batchId
          `);

        inserted = statsResult.recordset[0]?.Inserted || 0;
        updated = statsResult.recordset[0]?.Updated || 0;
      } catch (statsErr) {
        logger.warn(`Could not fetch stats (non-fatal): ${statsErr.message}`);
      }

      const totalDuration = Date.now() - startTime;
      const finalTotalParts = inserted + updated;

      // ====================== UPDATE STATUS & COUNTERS ======================
      const postProcessing = [];

      if (context.updateApiKeyStatus) {
        postProcessing.push(
          context.updateApiKeyStatus(pool, userId, description, source, 200, {
            errorMessage: `Inserted: ${inserted}, Updated: ${updated}, Deleted: ${deletedRows}`,
            inserted,
            updated,
            deleted: deletedRows,
            totalParts: finalTotalParts
          })
        );
      }

      postProcessing.push(
        executeWithRetry(
          () => pool.request()
            .input('userId', sql.VarChar, userId)
            .input('description', sql.VarChar, description)
            .input('source', sql.VarChar, source)
            .input('inserted', sql.Int, inserted)
            .input('updated', sql.Int, updated)
            .input('totalParts', sql.Int, finalTotalParts)
            .query(`
              UPDATE UserApiKeys
              SET count_inserted = @inserted,
                  count_updated  = @updated,
                  TotalParts     = @totalParts,
                  updated_at     = GETDATE()
              WHERE user_id = @userId 
                AND Description = @description 
                AND api_key_type = @source;
            `),
          { maxRetries: 3, logger }
        )
      );

      postProcessing.push(
        executeWithRetry(
          () => pool.request()
            .input('userId', sql.VarChar, userId)
            .input('source', sql.VarChar, source)
            .query(`
              UPDATE UserApiKeys
              SET CurrentBatchId = NULL, BatchStartedAt = NULL
              WHERE user_id = @userId 
                AND api_key_type = @source;
            `),
          { maxRetries: 3, logger }
        )
      );

      await Promise.all(postProcessing);

      // ====================== DECIDE WHAT TO DO NEXT ======================
      const minAge = MIN_AGE_HOURS || 48;

      if (manual) {
        await context.enqueueMessage({
          type: "PROCESS_MERCHANT",
          lastId: lastId,
          sandbox: isSandbox,
          manual: true
        });
      } else {
        // Always chain to PROCESS_MERCHANT.
        // The final PROCESS_MERCHANT will detect there are no more merchants
        // and trigger GLOBAL_REBUILD exactly once at the very end.
        await context.enqueueMessage({
          type: "PROCESS_MERCHANT",
          lastId: lastId,
          sandbox: isSandbox,
          manual: false
        });
      }

      logger.info(`📊 FINAL STATS | Inserted: ${inserted} | Updated: ${updated} | Deleted: ${deletedRows} | Time: ${totalDuration}ms`);
      logger.info(`✅ FINAL_CLEANUP completed for user ${userId}`);

      return { statusCode: 200 };

    } catch (err) {
      logger.error(`❌ FINAL_CLEANUP failed for user ${userId}: ${err.message}`);

      if (tx) {
        try { await tx.rollback(); } catch (_) {}
      }

      if (pool && context.updateApiKeyStatus) {
        try {
          await context.updateApiKeyStatus(pool, userId, description, source, 500, {
            errorMessage: `FINAL_CLEANUP failed: ${err.message}`
          });
        } catch (_) {}
      }

      throw err;
    }
  }
};