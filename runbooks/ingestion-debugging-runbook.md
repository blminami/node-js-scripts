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

Before debugging any ingestion, you need three identifiers that appear throughout the pipeline:

| Identifier | Where to find it | Applies to |
|---|---|---|
| `scraping_id` | Returned in the API response when ingestion is triggered; also in the network tab request/response or in the database | All ingestion types |
| `dataset_id` | Network tab on the initial ingestion request, or from the `article_ingestion_log` table | URL and domain ingestions only — file ingestions do not use Apify and have no `dataset_id` |
| `account_id` | Available from impersonation view in the merchant's account | All ingestion types |

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
WHERE scraping_id = 'SCRAPING_ID_HERE';
```

---

## Individual URL Ingestion

Use this section when a single URL was submitted for ingestion and the result is unexpected (empty article, wrong content, ingestion stuck, etc.).

Individual URL ingestion uses the **website content crawler** actor on the Apify side (not Cheerio, which is reserved for domain ingestion). Once the page is scraped, the content is sent **directly** to the ML service at `knowledge_discovery/external_snippet_transformation` for transformation — there is no intermediate GCS storage step and no Temporal workflow involved.

### Step 1 — Confirm the Apify Run

**Goal:** Verify that Apify received and processed the ingestion request.

1. Open the [Apify Console](https://console.apify.com/actors/runs).
2. Locate the run using the `dataset_id`:

```bash
# Get actor run ID and item count from dataset
curl -H "Authorization: Bearer $APIFY_API_KEY" \
  "https://api.apify.com/v2/datasets/DATASET_ID_HERE" \
  | jq '.data | {actRunId, itemCount, createdAt, modifiedAt}'
```

3. Confirm the actor run status:

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

**If `RUNNING` for > 30 min on a single URL:** Something is likely hanging. Abort and retry.

---

### Step 2 — Verify ML Transformation

**Goal:** Confirm that the scraped content was successfully sent to and processed by the ML service.

For individual URL ingestion, the website content crawler sends the extracted page content directly to `knowledge_discovery/external_snippet_transformation`. There is no intermediate GCS bucket file to inspect.

To debug this step, check the application logs for the ML transformation call:

```bash
kubectl logs -n default \
  -l app.kubernetes.io/instance=help-center,app.kubernetes.io/name=api \
  --all-containers --tail=1000 | grep -E "external_snippet_transformation|SCRAPING_ID_HERE"
```

Look for:
- The outgoing request to `knowledge_discovery/external_snippet_transformation`
- Any error responses from the ML service (timeouts, 4xx/5xx)
- Whether the transformation returned enriched content or an empty result

If the Apify run succeeded (`itemCount > 0`) but the output article is empty or poor quality, the issue is in this ML transformation step.

---

### Step 3 — Verify the Output Article

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

If `body_draft` is empty or thin and the Apify run succeeded, check the ML transformation logs in Step 2.

---

### Common Issues — Individual URL

| Symptom | Likely Cause | Action |
|---|---|---|
| Apify run succeeded but article is empty | ML transformation returned no content | Check ML service logs for the `external_snippet_transformation` call |
| Article contains unexpected/hidden content | Content present in static HTML but not rendered in browser | Expected behaviour — not a bug |
| `status: PENDING` after 30+ min | Webhook not received | Check Apify actor run status; trigger webhook manually if actor is done |
| `status: FAILED` immediately | URL invalid, blocked, or auth required | Check Apify run logs for HTTP error |
| 409 Conflict on re-trigger | Another PENDING run exists, or 24h rate limit active | Wait or check `latest_sync` timestamp |

---

## Domain Ingestion

Use this section when a full domain crawl is underway or has completed with unexpected results (missing pages, too few articles, stuck ingestion, etc.).

Domain ingestion uses the **Cheerio scraper** actor on the Apify side. Cheerio operates on the server-rendered HTML of each page — it extracts all text content present in the static markup, regardless of whether that content is visible to the end user in the browser. This includes text inside hidden elements, `<noscript>` tags, non-displayed `<div>` blocks, and other server-side rendered content that client-side JavaScript might suppress or hide. This is expected behaviour — content that appears "missing" from the UI may still be present in what Cheerio scraped and sent to ML.

### Step 1 — Check Overall Run Progress

Domain ingestions can take hours depending on the number of pages. First confirm whether it is genuinely stuck or still running:

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

If `mins_since_last_update > 180` and `article_count = 0`, the stuck job processor will mark this as `FAILED` within 3 days automatically. For urgent cases, intervene manually (see the main runbook: [Fix Stuck Ingestion](./website-ingestion-runbook.md#procedure-fix-stuck-ingestion)).

---

### Step 2 — Check Apify Dataset and Confirm Actor Run Success

Get the dataset item count and verify the actor run completed successfully:

```bash
# Get dataset info and actor run ID
curl -H "Authorization: Bearer $APIFY_API_KEY" \
  "https://api.apify.com/v2/datasets/DATASET_ID_HERE" \
  | jq '.data | {itemCount, actRunId, createdAt}'
```

```bash
# Confirm actor run status
curl -H "Authorization: Bearer $APIFY_API_KEY" \
  "https://api.apify.com/v2/actor-runs/ACTOR_RUN_ID_HERE" \
  | jq '.data | {status, startedAt, finishedAt, exitCode, stats}'
```

**Expected:** `status: SUCCEEDED`, `itemCount` reflects the number of pages crawled.

If `itemCount` is lower than expected:

1. Open the actor run in Apify Console.
2. Check the **Request Queue** tab — are URLs being discovered and enqueued?
3. Check if the domain uses a JavaScript-rendered navigation that Cheerio cannot follow (Cheerio only reads static HTML, so dynamically generated navigation menus won't be traversed).

---

### Step 3 — Check the Storage Bucket

For domain ingestions, scraped files are stored in the production GCS bucket under:

```
discovery-usa / website-scraping / {account_id} / {shop_type} / {shop_name} / {page_type} / {page_id} / {scraping_id}
```

Browse by `account_id` (obtained via impersonation) to see all scraped content for the merchant. You can spot-check individual page files to confirm the text content ML received.

**Reminder:** Cheerio captures all text in the server-rendered markup. If you find content in a bucket file that isn't visible in the browser, that is expected — it exists in the static HTML and was legitimately scraped.

If there are multiple ingestion files for the same page, **use the latest one** — or cross-reference the `scraping_id` in the filename to confirm it matches your run.

---

### Step 4 — Validate Temporal Workflow

**Goal:** Confirm that the post-scraping Temporal workflow ran successfully and processed all scraped pages into articles.

Access [Temporal in production](https://temporal.example.com) — **not staging**.

Filter by Workflow ID, which follows this format:

```
{account_id}_{shop_type}_{shop_name}_{scraping_id}
```

Check the workflow status:

- **`COMPLETED`:** The workflow ran successfully. All scraped pages were processed.
- **`FAILED`:** Expand the workflow to identify the failing activity. Look for errors in the article creation or ML transformation steps. Check if it is a partial failure (some pages created, others not) by cross-referencing `article_ids` count in the DB against the Apify `itemCount`.
- **`RUNNING`:** Still processing — normal for large domains.
- **No workflow found:** The success webhook from Apify may not have been delivered. See [Webhook Delivery Failures](./website-ingestion-runbook.md#alert-webhook-delivery-failures) in the main runbook.

**Check for partial failures:**

```sql
SELECT
  array_length(article_ids, 1) as articles_created
FROM article_ingestion_log
WHERE scraping_id = 'SCRAPING_ID_HERE';
```

If `articles_created` is significantly lower than the Apify `itemCount`, some pages failed during Temporal processing. Inspect the individual activity failures in the Temporal UI for the affected page URLs.

---

### Step 5 — Check Created Articles

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
| Very few pages scraped | JS-rendered navigation (Cheerio can't follow it), no sitemap, or anti-bot blocking | Check request queue in Apify Console |
| Ingestion stuck at 0 articles for > 3h | Actor failed silently or webhook missed | Check Apify actor run status; trigger fail webhook if actor is done |
| Ingestion running > 30h | Expected for domains with a large number of pages | Normal — monitor progress via `article_count` in the DB |
| Temporal workflow FAILED | Article creation or ML transformation error | Check failing activity in Temporal UI; compare `article_ids` count vs Apify `itemCount` |

---

## File Ingestion

Use this section when a file upload (e.g. PDF, CSV) was submitted for ingestion and the result is missing, malformed, or incomplete.

### Step 1 — Confirm the Ingestion Record

```sql
SELECT
  id,
  scraping_id,
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
    │    └─ Check Apify actor status (URL/domain only) → still running or webhook missed?
    │         ├─ Running: wait
    │         ├─ Succeeded, no webhook: trigger /ingestion/done manually
    │         └─ Failed, no webhook: trigger /ingestions/fail manually
    │
    ├─ FAILED
    │    └─ Was it a site/file issue or a pipeline issue?
    │         ├─ Apify run shows HTTP 403/captcha: site is blocking
    │         ├─ Apify run shows timeout: site too large
    │         ├─ File ingestion: check GCS for valid file
    │         └─ Webhook/Temporal error: retry ingestion
    │
    └─ SUCCESSFUL but bad output
         ├─ URL ingestion: check ML transformation logs (external_snippet_transformation)
         ├─ Domain ingestion: check raw content in GCS bucket, then Temporal workflow
         │    └─ Content present in bucket but poor articles: ML transformation issue
         │         └─ Check Temporal workflow for transformation errors
         └─ File ingestion: check ingested_resource content_length and Temporal workflow
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
