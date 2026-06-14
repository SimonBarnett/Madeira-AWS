# 🛒 Madeira SQS Merchant Pipeline

`madeira-sqs-merchant` is the Lambda responsible for **importing full product catalogues** from merchant platforms.

It is the primary way merchants get their products into the Madeira system so they can be discovered by clubs and communities.

## Supported Merchant Platforms

| Platform       | Logo | Connector File     | Notes                              |
|----------------|------|--------------------|------------------------------------|
| **Shopify**    | ![Shopify](https://img.shields.io/badge/Shopify-7AB55C?style=flat&logo=shopify&logoColor=white) | `shopify.js`      | Full catalogue import             |
| **WooCommerce**| ![WooCommerce](https://img.shields.io/badge/WooCommerce-96588A?style=flat&logo=woocommerce&logoColor=white) | `woocommerce.js`  | Full catalogue import             |
| **Magento**    | ![Magento](https://img.shields.io/badge/Magento-EE672F?style=flat&logo=magento&logoColor=white) | `magento.js`      | Full catalogue import             |
| **Wix**        | ![Wix](https://img.shields.io/badge/Wix-0C6EFA?style=flat&logo=wix&logoColor=white) | `wix.js`          | Full catalogue import             |
| **BigCommerce**| ![BigCommerce](https://img.shields.io/badge/BigCommerce-121118?style=flat&logo=bigcommerce&logoColor=white) | *(planned)*       | Planned                           |

## Purpose

- Connect to merchant stores via their APIs (using stored API keys)
- Pull complete product catalogues
- Transform and normalize the data
- Insert into the central `MerchantProducts` table
- Handle incremental updates and stale data cleanup
- Support multiple merchant platforms through dedicated connectors

## Key Concepts

### Merchant Connectors

Each supported platform has its own connector in the `routes/` folder:

- `shopify.js`
- `woocommerce.js`
- `magento.js`
- `wix.js`
- etc.

These connectors handle authentication, pagination, and data normalization for their specific platform.

### Stale Pair Detection

The system tracks which merchants need refreshing using `UserApiKeys` + last status timestamps.

A merchant is considered “stale” when:
- It has never been synced
- The last successful sync is older than `MIN_AGE_HOURS` (default 168 hours / 7 days)
- The previous sync failed

### Maintenance Window

A special `MAINTAINANCE_WINDOW` message can be sent (usually via EventBridge scheduler) to trigger bulk cleanup and re-indexing jobs.

## Sandbox Mode

The `sandbox` parameter is respected throughout the pipeline.

**When `sandbox: true`:**
- No real merchant API calls are made (or limited to test stores)
- Database writes are skipped or use test markers
- Useful for testing new connectors or data transformation logic safely

## Environment Variables

| Variable                              | Default     | Description                                      |
|---------------------------------------|-------------|--------------------------------------------------|
| `DB_BATCH_SIZE`                       | 4000        | Number of records per database batch insert      |
| `FINAL_CLEANUP_DELAY_MS`              | 4000        | Delay before final cleanup step                  |
| `LARGE_MERCHANT_BATCH_THRESHOLD`      | 4           | Threshold for treating a merchant as “large”     |
| `LOG_LEVEL`                           | debug       | Logging verbosity                                |
| `MERGE_BATCH_ENQUEUE_DELAY_MS`        | 150         | Delay between enqueuing merge batches            |
| `MIN_AGE_HOURS`                       | 168         | Minimum age before a merchant is considered stale|
| `S3_RESULTS_BUCKET`                   | -           | Bucket for temporary result storage              |
| `SQS_QUEUE_URL`                       | -           | The merchant processing queue URL                |

## Typical Flow

1. Scheduler or manual trigger selects eligible merchants
2. Connector fetches products from the merchant platform
3. Products are normalized and inserted/updated in `MerchantProducts`
4. Old/stale products are cleaned up
5. Indexes are rebuilt if needed
6. Status is updated in `UserApiKeys`

## Related Documentation

- [Merchant Routes (Connectors)](./routes/readme.md) — Detailed connector logic per platform
- [SQS Message Handlers](./sqs/readme.md) — Core processing, batching, and maintenance logic

---

**Last updated:** 14 June 2026