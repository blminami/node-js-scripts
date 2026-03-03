# Ingestion Debugging Runbook

**Service:** Website / File Ingestion
**Team:** Flywheel
**Last Updated:** 2025

---

## Overview

This runbook covers step-by-step debugging for three ingestion types:

1. [Individual URL Ingestion](#individual-url-ingestion)
2. [Domain Ingestion](#domain-ingestion)
3. [File Ingestion](#file-ingestion)

Each section walks through the full debugging pipeline: from verifying the Apify run, inspecting raw scraped content in the storage bucket, to validating Temporal workflow execution.

---

## Prerequisites: Finding Your Key Identifiers

Before debugging any ingestion, you need two identifiers that appear throughout the pipeline:

| Identifier | Where to find it |
|---|---|
| `scraping_id` | Returned in the API response when ingestion is triggered; also in the network tab request/response or in the database |
| `dataset_id` | Network tab on the initial ingestion request, or from the `article_ingestion_log` table |
| `account_id` | Available from impersonation view in the merchant's account |

**Quick lookup from the database:**

```sql
SELECT
  id,
  scraping_id,
  dataset_id,
  account_id,
  help_center_id,
  url,
  source,
  status,
  created_datetime,
  updated_datetime
FROM article_ingestion_log
WHERE scraping_id = 'SCRAPING_ID_HERE'
   OR dataset_id = 'DATASET_ID_HERE';
```

---

## Individual URL Ingestion

Use this section when a single URL was submitted for ingestion and the result is unexpected (empty article, wrong content, ingestion stuck, etc.).

### Step 1 — Confirm the Apify Run

**Goal:** Verify that Apify received and processed the ingestion request.

1. Open the [Apify Console](https://console.apify.com/actors/runs).
2. Filter runs by your actor ID (`GORGIAS_APIFY_CHEERIO_ACTOR` or `GORGIAS_APIFY_CRAWLER_ACTOR`).
3. Locate the run using the `dataset_id`:

```bash
# Get actor run ID from dataset
curl -H "Authorization: Bearer $APIFY_API_KEY" \
  "https://api.apify.com/v2/datasets/DATASET_ID_HERE" \
  | jq '.data | {actRunId, itemCount, createdAt, modifiedAt}'
```

4. Confirm the actor run status:

```bash
curl -H "Authorization: Bearer $APIFY_API_KEY" \
  "https://api.apify.com/v2/actor-runs/ACTOR_RUN_ID_HERE" \
  | jq '.data | {status, startedAt, finishedAt, exitCode, stats}'
```

**Expected:** `status: SUCCEEDED`, `itemCount > 0`

**If `FAILED` or `TIMED_OUT`:** Check Apify run logs for the error. Common causes:
  - The page is behind authentication
  - The site blocks crawlers (check for 403/captcha in run logs)
  - The URL redirects to an unexpected destination
  - JavaScript rendering required — consider switching actor to `GORGIAS_APIFY_CRAWLER_ACTOR`

**If `RUNNING` for > 30 min on a single URL:** Something is likely hanging. Abort and retry.

---

### Step 2 — Inspect Raw Scraped Content in the Storage Bucket

**Goal:** See exactly what the Cheerio scraper sent to ML before any transformation.

The raw scraped content is stored in the production GCS bucket under:

```
discovery-usa / website-scraping / {account_id} / {shop_type} / {shop_name} / product / {product_id} / {scraping_id}
```

**How to navigate there:**

1. Impersonate the merchant account to get the `account_id`.
2. Identify the `shop_type` (e.g. `shopify`), `shop_name`, and `product_id`.
   - The `product_id` can be taken from:
     - The URL of the product page on the merchant's store
     - The product ID field in the Shopify admin panel
3. In the bucket, if there are multiple ingestion files for the same product, **use the latest one** — or cross-reference with the `scraping_id` in the filename to confirm it matches your run.

**What to look for:**

- The file contains the raw text extracted by Cheerio — this is what ML receives as input.
- **Important:** Content that is not visible in the browser UI (e.g. hidden text, static HTML that JS would normally hide) **can still be present** here. Cheerio reads the static HTML directly, not the rendered DOM.
- Open the source URL listed in the file to compare — you may find the information exists in a `<noscript>`, a hidden `<div>`, or a `<script>` block.

**Example check:**

If ML produced a "5-year guarantee" attribute that you don't see on the page:

1. Open the raw bucket file for that product ingestion.
2. Search for "5-year" or "guarantee".
3. If found: the data is legitimately in the static HTML. Open the page source URL from the file and confirm.
4. This is expected behaviour — it is **not** a pipeline issue.

---

### Step 3 — Validate the Temporal Workflow

**Goal:** Confirm that the post-scraping ML workflow ran successfully.

Access [Temporal in production](https://temporal.example.com) — **not staging**.

Filter by Workflow ID, which follows this format:

```
{account_id}_{shop_type}_{shop_name}_{scraping_id}
```

Check the workflow:

- **Status `COMPLETED`:** Everything ran successfully.
- **Status `FAILED`:** Expand the workflow to find the failing activity and its error message.
- **No workflow found:** The webhook from Apify may not have been delivered. See [Webhook Delivery Failures](./website-ingestion-runbook.md#alert-webhook-delivery-failures) in the main runbook.

---

### Step 4 — Verify the Output Article

```sql
SELECT
  a.id,
  at.title,
  at.body_draft,
  a.status,
  a.created_datetime
FROM article a
JOIN article_translation at ON at.article_id = a.id
WHERE a.id = ANY(
  SELECT unnest(article_ids)
  FROM article_ingestion_log
  WHERE scraping_id = 'SCRAPING_ID_HERE'
)
ORDER BY a.created_datetime DESC;
```

If `body_draft` is empty or thin, go back to Step 2 — the issue is likely in what Cheerio was able to extract from the static HTML.

---

### Common Issues — Individual URL

| Symptom | Likely Cause | Action |
|---|---|---|
| Apify run succeeded but article is empty | JS-rendered content, Cheerio can't see it | Switch to `CRAWLER_ACTOR`; check static HTML manually |
| Article contains unexpected/hidden content | Content present in static HTML but not rendered | Expected behaviour — not a bug |
| `status: PENDING` after 30+ min | Webhook not received or Temporal stalled | Check Temporal workflow; trigger webhook manually if needed |
| `status: FAILED` immediately | URL invalid, blocked, or auth required | Check Apify run logs for HTTP error |
| 409 Conflict on re-trigger | Another PENDING run exists, or 24h rate limit active | Wait or check `latest_sync` timestamp |

---

## Domain Ingestion

Use this section when a full domain crawl is underway or has completed with unexpected results (missing pages, too few/many articles, stuck ingestion, etc.).

### Step 1 — Check Overall Run Progress

Domain ingestions can take hours. First confirm whether it is genuinely stuck or still running:

```sql
SELECT
  id,
  url,
  status,
  dataset_id,
  scraping_id,
  array_length(article_ids, 1) as article_count,
  created_datetime,
  updated_datetime,
  EXTRACT(EPOCH FROM (NOW() - updated_datetime))/60 as mins_since_last_update
FROM article_ingestion_log
WHERE scraping_id = 'SCRAPING_ID_HERE';
```

**Reference timings:**

| Domain size | Expected duration |
|---|---|
| < 50 pages | 30 min – 2 hours |
| 50–500 pages | 2–8 hours |
| 500+ pages | Up to 30 hours (Apify actor timeout) |

If `mins_since_last_update > 180` and `article_count = 0`, the stuck job processor will mark this as `FAILED` within 3 days automatically. For urgent cases, intervene manually (see the main runbook: [Fix Stuck Ingestion](./website-ingestion-runbook.md#procedure-fix-stuck-ingestion)).

---

### Step 2 — Check Apify Dataset Item Count

```bash
curl -H "Authorization: Bearer $APIFY_API_KEY" \
  "https://api.apify.com/v2/datasets/DATASET_ID_HERE" \
  | jq '.data | {itemCount, actRunId, createdAt}'
```

If `itemCount` is low compared to what you'd expect:

1. Open the actor run in Apify Console.
2. Check the **Request Queue** tab — are URLs being discovered and enqueued?
3. Check if the domain uses a non-standard sitemap or a JavaScript-rendered navigation that Cheerio cannot follow. If so, `CRAWLER_ACTOR` is required.

---

### Step 3 — Sample Scraped Pages

Pull a sample of dataset items to assess extraction quality:

```bash
curl -H "Authorization: Bearer $APIFY_API_KEY" \
  "https://api.apify.com/v2/datasets/DATASET_ID_HERE/items?limit=10" \
  | jq '.[] | {url, title, textLength: (.text | length)}'
```

If `textLength` is consistently 0 or very low across multiple URLs, the site likely requires JavaScript rendering.

---

### Step 4 — Check the Storage Bucket

For domain ingestions, scraped files are stored under:

```
discovery-usa / website-scraping / {account_id} / {shop_type} / {shop_name} / {page_type} / {page_id} / {scraping_id}
```

Browse by `account_id` (obtained via impersonation) to see all scraped content for the merchant. You can spot-check individual page files to confirm the text content ML received.

---

### Step 5 — Validate Temporal Workflow

Same as for individual URL ingestion (Step 3 above). For domain ingestions, the Temporal workflow handles batch article creation — check for partial failures where some pages succeeded but others did not.

---

### Step 6 — Check Created Articles

```sql
SELECT
  COUNT(*) as total_articles,
  COUNT(*) FILTER (WHERE at.body_draft IS NOT NULL AND LENGTH(at.body_draft) > 100) as articles_with_content,
  MIN(a.created_datetime) as first_created,
  MAX(a.created_datetime) as last_created
FROM article a
JOIN article_translation at ON at.article_id = a.id
WHERE a.id = ANY(
  SELECT unnest(article_ids)
  FROM article_ingestion_log
  WHERE scraping_id = 'SCRAPING_ID_HERE'
);
```

---

### Common Issues — Domain Ingestion

| Symptom | Likely Cause | Action |
|---|---|---|
| Very few pages scraped | JS navigation, no sitemap, anti-bot blocking | Check request queue in Apify; switch actor if needed |
| Ingestion stuck at 0 articles for > 3h | Actor failed silently, webhook missed | Check Apify actor run status; trigger fail webhook if actor is done |
| Too many irrelevant pages scraped | No URL filtering configured | Re-trigger with URL include/exclude patterns |
| Some articles empty | Mixed rendering (some pages need JS) | Expected if site is hybrid; consider per-URL ingestion for key pages |
| Ingestion running > 30h | Site too large or actor hung | Actor will timeout at 30h; consider breaking into smaller domains |

---

## File Ingestion

Use this section when a file upload (e.g. PDF, CSV) was submitted for ingestion and the result is missing, malformed, or incomplete.

### Step 1 — Confirm the Ingestion Record

```sql
SELECT
  id,
  scraping_id,
  dataset_id,
  account_id,
  help_center_id,
  url,
  source,
  status,
  created_datetime,
  updated_datetime
FROM article_ingestion_log
WHERE help_center_id = HELP_CENTER_ID_HERE
  AND source = 'file'
ORDER BY created_datetime DESC
LIMIT 10;
```

File ingestions use `source = 'file'` and do not go through Apify — they follow a different path through the pipeline.

---

### Step 2 — Check the Uploaded File in GCS

File ingestions are stored in GCS before processing. Confirm the file was uploaded correctly:

1. Navigate to the storage bucket.
2. Locate the file under the account's directory (use `account_id` from impersonation).
3. Download and manually inspect the file:
   - **PDF:** Confirm text is extractable (not a scanned image). Scanned PDFs produce no extractable text.
   - **CSV:** Confirm the delimiter, encoding (UTF-8), and column headers are as expected.

**If the file is missing from the bucket:** The upload step failed before ingestion was triggered. Ask the user to re-upload.

---

### Step 3 — Check Ingested Resources

```sql
SELECT
  id,
  url,
  title,
  LENGTH(content) as content_length,
  status,
  created_datetime
FROM ingested_resource
WHERE article_ingestion_log_id = (
  SELECT id FROM article_ingestion_log
  WHERE scraping_id = 'SCRAPING_ID_HERE'
)
ORDER BY created_datetime DESC;
```

- `content_length = 0`: File parsing produced no text. The file may be image-based (scanned PDF) or corrupted.
- `content_length` very small: Partial extraction. Check if the file has copy-protection or unusual encoding.

---

### Step 4 — Validate the Temporal Workflow

Access [Temporal in production](https://temporal.example.com) and filter by Workflow ID:

```
{account_id}_{shop_type}_{shop_name}_{scraping_id}
```

For file ingestions, Temporal handles the ML transformation step. If the workflow shows a failure:

1. Expand the failing activity.
2. Look for errors related to file parsing, text extraction, or ML transformation.
3. If the error is a transient ML timeout, the workflow can be retried from the Temporal UI.

---

### Step 5 — Verify Output Articles

```sql
SELECT
  a.id,
  at.title,
  LENGTH(at.body_draft) as body_length,
  a.status,
  a.created_datetime
FROM article a
JOIN article_translation at ON at.article_id = a.id
WHERE a.id = ANY(
  SELECT unnest(article_ids)
  FROM article_ingestion_log
  WHERE scraping_id = 'SCRAPING_ID_HERE'
)
ORDER BY a.created_datetime DESC;
```

---

### Common Issues — File Ingestion

| Symptom | Likely Cause | Action |
|---|---|---|
| `status: FAILED` immediately | File missing from GCS, corrupt upload, or unsupported format | Check GCS for the file; confirm format is supported |
| Article empty after success | Scanned PDF (image-based, no text layer) | Inform user — OCR is not currently supported |
| Partial content extracted | PDF has mixed text/image pages | Expected; only text pages are extractable |
| Ingestion record not found | Upload did not complete; ingestion never triggered | Ask user to re-upload |
| Content garbled or wrong encoding | File is not UTF-8 | Ask user to re-save file as UTF-8 |
| Temporal workflow failed | ML transformation error | Check Temporal activity error; retry from Temporal UI if transient |

---

## Quick Decision Tree

```
Ingestion issue reported
         │
         ▼
Does article_ingestion_log record exist?
  ├─ NO  → Ingestion was never triggered. Check API request; ask user to retry.
  └─ YES ▼
         │
    What is the status?
    ├─ PENDING
    │    └─ Check Apify actor status → still running or webhook missed?
    │         ├─ Running (< 30h): wait
    │         ├─ Running (> 30h): actor should time out soon
    │         ├─ Succeeded, no webhook: trigger /ingestion/done manually
    │         └─ Failed, no webhook: trigger /ingestions/fail manually
    │
    ├─ FAILED
    │    └─ Was it a site/file issue or a pipeline issue?
    │         ├─ Apify run shows HTTP 403/captcha: site is blocking
    │         ├─ Apify run shows timeout: site too large or JS-heavy
    │         ├─ File ingestion: check GCS for valid file
    │         └─ Webhook/Temporal error: retry ingestion
    │
    └─ SUCCESSFUL but bad output
         └─ Check raw content in GCS bucket
              ├─ Content missing from bucket: scraper extracted nothing
              │    └─ Site needs JS rendering → switch actor
              └─ Content present in bucket: ML transformation issue
                   └─ Check Temporal workflow for transformation errors
```

---

## Related Documentation

- [Website Ingestion Runbook](./website-ingestion-runbook.md) — operational procedures, stuck jobs, webhook handling
- [Apify Console](https://console.apify.com/actors/runs)
- [Temporal (Production)](https://temporal.example.com)
- [Apify API Docs](https://docs.apify.com/)

---

## Changelog

| Date | Change | Author |
|---|---|---|
| 2025 | Initial debugging runbook created | — |

---

**End of Runbook**
