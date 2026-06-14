# 🛠️ Madeira SQS Catalogue Pipeline

`madeira-sqs-catalogue` is the central orchestration queue for **club/community onboarding** and **live catalogue management**.

It coordinates the full lifecycle of a club’s product catalogue — from initial onboarding through AI category generation, catalog building, and ongoing updates.

## Purpose

This queue handles:

- New club/community onboarding (triggered from the API)
- AI-powered category generation using Grok
- Building the live searchable catalogue
- Notifying stakeholders when processing completes
- Handling manual category updates from the UI

## Key Message Types

| Message Type                    | Triggered From                  | Purpose                                                                 | Next Step(s)                              |
|---------------------------------|---------------------------------|-------------------------------------------------------------------------|-------------------------------------------|
| `ONBOARDING`                    | API `/login/onboarding`         | Starts full onboarding flow for a new club                              | `CLUBSCAN_GENERATE_REVIEW`                |
| `CLUBSCAN_GENERATE_REVIEW`      | Onboarding / manual             | Generates AI review + initial analysis                                  | `CLUBSCAN_GENERATE_CATEGORIES`            |
| `CLUBSCAN_GENERATE_CATEGORIES`  | Previous step                   | Uses Grok to suggest smart discount categories                          | `CLUBSCAN_BUILD_CATALOG`                  |
| `CLUBSCAN_BUILD_CATALOG`        | Previous step                   | Builds the live `Catalog` + `Products` tables                           | `CLUBSCAN_NOTIFY` (if `enqueueNotify=true`) |
| `CLUBSCAN_NOTIFY`               | Onboarding (with flag)          | Sends success/failure emails to stakeholders                            | —                                         |
| `CATEGORY_UPDATE`               | UI `/ui/category`               | Allows partners to add/edit categories via natural language prompt      | Rebuilds relevant parts of the catalogue  |

## Sandbox Mode

Almost every message supports `sandbox: true`.

**When `sandbox: true`:**
- No real emails are sent (or sent only to `SANDBOX_NOTIFY`)
- Status updates still occur for debugging
- Grok calls may be limited or mocked
- Useful for testing the entire onboarding flow safely

## Important Design Notes

- Status tracking now uses `clubscan.Status` (e.g. `onboarding`, `onboarding_complete`, `catalog_complete`)
- The old `isProcessing` flag has been removed
- Email sending was moved out of the API into this queue (centralized)
- `enqueueNotify` flag controls whether `CLUBSCAN_NOTIFY` is called after catalog build (true during onboarding)

## Environment Variables

| Variable            | Example Value                          | Purpose                                      |
|---------------------|----------------------------------------|----------------------------------------------|
| `NOTIFY`            | `stakeholder@madeira.uk`               | Production notification email                |
| `SANDBOX_NOTIFY`    | `si@ntsa.uk`                           | Sandbox notification email                   |
| `SQS_QUEUE_URL`     | `https://sqs.../madeira-category-queue` | The SQS queue this Lambda listens to         |

## Typical Onboarding Flow (from API)

1. Partner triggers onboarding via widget/API
2. `ONBOARDING` message is enqueued
3. Full pipeline runs: Review → Categories → Catalog Build
4. If `enqueueNotify=true`, success email is sent
5. Club is ready to use the catalogue widget

## Related Documentation

- [SQS Message Handlers](./sqs/readme.md) — Detailed logic for each message type
- [API Token Routes](../API/routes/token/readme.md) — Where `ONBOARDING` is triggered
- [Category UI](../API/routes/ui/readme.md) — `CATEGORY_UPDATE` handling

---

**Last updated:** 14 June 2026