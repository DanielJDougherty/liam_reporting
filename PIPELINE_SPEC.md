# Liam Reporting Pipeline — Technical Specification for Production Replication

> **Purpose**: Enable the SWE team and lead architect to replicate this pipeline in Airflow (or equivalent orchestrator) on production cloud infrastructure.

---

## 1. System Overview

**What it does**: Ingests voice call data from the Vapi AI platform, enriches each call with GPT-powered classification, generates executive performance reports, and delivers them as branded HTML emails.

**Current orchestration**: GitHub Actions cron jobs running Node.js scripts on `ubuntu-latest` runners. The goal is to migrate this to Airflow or a similar DAG-based orchestrator.

**Runtime**: Node.js v20, no database — all state is JSON files on disk.

---

## 2. Pipeline DAG (Task Dependency Graph)

```
                    ┌─────────────┐
                    │  FETCH       │  Task 1 — Ingest raw calls from Vapi API
                    │  fetch.js    │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  ENRICH      │  Task 2 — Classify calls via GPT-4o-mini
                    │  enrich.js   │
                    └──────┬──────┘
                           │
                    ┌──────┴──────┐
                    ▼             ▼
            ┌─────────────┐ ┌──────────────┐
            │ REPORT: DOD  │ │ REPORT:      │  Task 3 — Generate report
            │ report-day-  │ │ INTRADAY     │  (only one runs per schedule)
            │ over-day.js  │ │ report-      │
            └──────┬──────┘ │ intraday.js  │
                   │        └──────┬───────┘
                   └──────┬───────┘
                          ▼
                   ┌─────────────┐
                   │  EMAIL       │  Task 4 — Send branded HTML email
                   │  email-      │           via Microsoft Graph API
                   │  sender.js   │
                   └─────────────┘
```

**Dependency rule**: Strictly linear. Each task depends on the output of the previous one. No parallelism within a single pipeline run.

**The orchestrator script that chains these today**: `scripts/scheduled-report.js`

---

## 3. Task-by-Task Specification

### Task 1: FETCH — `scripts/fetch.js`

| Attribute | Detail |
|-----------|--------|
| **Command** | `node scripts/fetch.js --client=lf01 --days=2` |
| **External dependency** | Vapi API (`https://api.vapi.ai/call`) |
| **Auth** | `VAPI_API_KEY` (Bearer token) |
| **Input** | Client config (`clients/lf01/config/client.json`) for phone number filters |
| **Processing** | Paginated GET (100 calls/page, max 50 pages), filters by phone number + date range, deduplicates by call ID, merges with any existing raw files |
| **Output** | `clients/lf01/data/raw/vapi_calls_YYYY-MM-DD.json` (one file per calendar day) |
| **State update** | Updates `clients/lf01/data/metadata.json` — `lastFetchTimestamp`, `totalCallsStored` |
| **Timeout** | 30s per HTTP request |
| **Idempotency** | Safe to re-run. Deduplicates by call ID via Map merge. |
| **Failure mode** | Throws on missing API key or HTTP error. Exit code 1. |

### Task 2: ENRICH — `scripts/enrich.js`

| Attribute | Detail |
|-----------|--------|
| **Command** | `node scripts/enrich.js --client=lf01 --start=YYYY-MM-DD --end=YYYY-MM-DD --force` |
| **External dependency** | OpenAI API (model: `gpt-4o-mini`) |
| **Auth** | `OPENAI_API_KEY` |
| **Input** | Raw call files from Task 1 + existing enrichments + prompt templates from `clients/lf01/config/prompts.json` |
| **Processing** | (see Section 4 below for full enrichment logic) |
| **Output** | `clients/lf01/data/enriched/vapi_enriched_YYYY-MM-DD.json` (one file per day, keyed by callId) |
| **State update** | Updates `metadata.json` — `lastEnrichmentTimestamp`, `totalCallsEnriched` |
| **Batch size** | 50 calls per GPT request (configurable) |
| **Rate limiting** | 1-second sleep between batches |
| **Idempotency** | Safe to re-run. Only processes calls not already enriched (unless `--force`). |
| **Failure mode** | Returns `"unknown"` classification on GPT error, then applies rule-based fallback overrides. |

### Task 3: REPORT GENERATION — `scripts/report-day-over-day.js` OR `scripts/report-intraday.js`

| Attribute | Detail |
|-----------|--------|
| **Command (DOD)** | `node scripts/report-day-over-day.js --client=lf01 --date=YYYY-MM-DD` |
| **Command (Intraday)** | `node scripts/report-intraday.js --client=lf01 --date=YYYY-MM-DD` |
| **External dependency** | None (pure computation on local files) |
| **Input** | Raw files + enriched files + client config (`report.json`, `revenue.json`, `client.json`) |
| **Processing** | Merges raw call data with enrichments, computes metrics (call counts by category, success rates, duration stats), extracts emails/leads, calculates ROI, generates Markdown report |
| **Output** | `clients/lf01/data/reports/EngAgent_DODReport_Start{DATE}_End{DATE}_{TIMESTAMP}.md` + corresponding `_meta.json` |
| **Validation** | `validateReportDate()` ensures the generated report filename matches the requested target date. Throws error on mismatch (prevents sending stale data). |
| **Idempotency** | Creates new timestamped files each run. Does not delete previous reports. |

### Task 4: EMAIL — `core/lib/email-sender.js`

| Attribute | Detail |
|-----------|--------|
| **External dependency** | Microsoft Graph API |
| **Auth** | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (Service Principal with Mail.Send permission) |
| **Input** | Report Markdown file + `_meta.json` + client branding config |
| **Processing** | Markdown to HTML conversion (`marked` library), wraps in branded email chrome (table-based layout for Outlook compatibility), embeds client logo as inline base64 attachment, constructs metadata chips (call counts, dates) |
| **Output** | Email sent to recipients defined in `client.json` |
| **Recipients** | `email.toProduction` (takes priority) or `email.to` (dev fallback). Optional CC via `email.ccProduction`/`email.cc`. |
| **Failure mode** | Single attempt, no retry. Throws on failure. |

---

## 4. Enrichment Logic (Deep Dive)

This is the core intelligence of the pipeline. The enrichment classifies each call into one of 6 categories using a multi-layer approach: GPT classification first, then deterministic overrides, then a rule-based fallback engine.

**Source files**:
- `scripts/enrich.js` — orchestrates the enrichment pipeline
- `core/prompt-builder.js` — constructs GPT prompts from config templates
- `clients/lf01/config/prompts.json` — the actual prompt templates
- `core/lib/classify_call.js` — rule-based fallback classifier
- `core/lib/store_enrichment.js` — enrichment persistence layer

---

### 4a. Pre-Processing: Feature Extraction Per Call

Before any call is sent to GPT, `enrich.js` extracts 5 structured metadata fields from the raw Vapi call object. These are passed to GPT alongside the transcript/summary to ground classification in hard signals.

**Field 1: `duration` (integer, seconds)**
```
Source: Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000)
Fallback: 0 if timestamps missing
```

**Field 2: `endedReason` (string)**
```
Source: call.endedReason
Possible values from Vapi:
  - "assistant-forwarded-call"  → Transfer completed successfully
  - "customer-ended-call"       → Customer hung up
  - "assistant-ended-call"      → AI ended the call (after booking, polite goodbye, etc.)
  - "silence-timed-out"         → No speech detected for too long
  - "unknown"                   → Fallback
```

**Field 3: `transferDestinationHint` (string or null)**
```
Source: Extracted from call.messages[].toolCalls[]
Looks for function names: "intent_transfer", "transfer_intent", "transferCall"
Parses: JSON.parse(toolCall.function.arguments).destination or .intent
Result: e.g. "sales", "service-repair", "billing", or null
```

**Field 4: `appointmentBooked` (boolean)**
```
Source 1: call.analysis.artifact.structuredOutputs['Appointment Booked'].result === true
Source 2: call.analysis.successEvaluation (JSON string or object)
  - Parses: evalData.call_success === 'yes'
    AND evalData.final_outcome includes ("appointment" or "consultation")
    AND evalData.final_outcome includes ("scheduled" or "confirmed" or "booked")
    AND evalData.final_outcome does NOT include "transferred"
  - This careful check prevents marking a successful transfer as a booking
```

**Field 5: `summary` and `transcript`**
```
Source: call.summary (AI-generated, most reliable), call.transcript (full verbatim)
Transcript is truncated to first 500 characters for GPT context window efficiency
```

---

### 4b. GPT Classification — Prompt Architecture

**Model**: `gpt-4o-mini`
**Temperature**: `0.3` (low variance for consistent classifications)
**Response format**: `{ type: 'json_object' }` (forces valid JSON output)
**Batch size**: Up to 50 calls per single API request

#### System Prompt (from `prompts.json`)

```
You are a call classification expert for {{client.name}}, a {{client.industry}} company.
Analyze inbound calls to {{client.aiAssistantName}} and classify by outcome.
Return only valid JSON.
```

Template variables are resolved by `prompt-builder.js`:
- `{{client.name}}` → "Leaf"
- `{{client.industry}}` → "Gutter protection & gutter services"
- `{{client.aiAssistantName}}` → "Liam"

#### User Prompt Structure (from `prompts.json`)

The user prompt is assembled in this order:

1. **Business context block**: Company description, services list, AI assistant purposes
2. **Critical distinction rules**: NEW customer (booking categories) vs EXISTING customer (transferred)
3. **Metadata field definitions**: Explains what each field means to GPT
4. **Priority-ordered classification rules** (6 rules, applied in order):
   - RULE 1: `appointmentBooked === true` → always `booking-completed`
   - RULE 2: Existing customer keywords in summary → `transferred`
   - RULE 3: `endedReason === "assistant-forwarded-call"` → `transferred` or `booking-transferred`
   - RULE 4: `endedReason === "customer-ended-call"` + booking questions asked → `booking-abandoned`
   - RULE 5: `endedReason === "customer-ended-call"` + no booking questions → `hangup`
   - RULE 6: Duration < 5s → `spam`
5. **Category definitions** with detailed criteria (see taxonomy below)
6. **Expected JSON output format**

#### Dynamic Template Variables Injected

| Placeholder | Source | Example Value |
|-------------|--------|---------------|
| `{{client.name}}` | `client.json` | "Leaf" |
| `{{client.aiAssistantName}}` | `client.json` | "Liam" |
| `{{client.description}}` | `client.json` | "LeafFilter is the nation's leading gutter protection company..." |
| `{{client.primaryService}}` | `client.json` | "LeafFilter gutter protection" |
| `{{servicesList}}` | `client.services[]` joined with newlines | "- LeafFilter installation\n- Gutter cleaning\n- ..." |
| `{{callPurposesList}}` | `client.callPurposes[]` numbered | "1. Schedule free estimates\n2. ..." |
| `{{transferReasonsList}}` | `client.transferReasons{}` formatted | "- **sales**: New customer sales...\n- **billing**: ..." |
| `{{serviceKeywordsList}}` | `client.serviceKeywords[]` quoted | `"gutter", "LeafFilter", "leaf guard", ...` |
| `{{leadCriteriaList}}` | `client.leadCriteria[]` | "- Expressed specific interest in...\n- ..." |

#### Per-Call Data Sent to GPT

Each call in the batch is formatted as:
```
Call 1:
- ID: abc123
- Duration: 45s
- endedReason: customer-ended-call
- transferDestinationHint: none
- appointmentBooked: false
- Summary: Customer called about gutter cleaning pricing...
- Transcript: [first 500 chars]...
```

#### Expected GPT Response Format

```json
{
  "calls": [
    {
      "callId": "abc123",
      "category": "hangup",
      "transferReason": null,
      "spamType": null,
      "hangupType": "moderate"
    }
  ]
}
```

---

### 4c. Classification Taxonomy (6 Categories, Full Detail)

#### 1. `booking-completed` — NEW customer successfully booked
- **Definitive signal**: `appointmentBooked === true` (from Vapi structured outputs)
- **Transcript signals**: "appointment is confirmed for", "see you on [DATE]"
- **Success evaluation**: `call_success === "yes"` + `final_outcome` includes "appointment scheduled"
- **Critical guard**: Must be a NEW customer consultation, NOT an existing customer service call
- **Output fields**: `{ category: "booking-completed", hangupType: null, transferReason: null, spamType: null }`

#### 2. `booking-abandoned` — NEW customer started booking, then hung up
- **Signals**: AI asked homeowner status, phone number, or email (booking qualification questions)
- **Required**: `endedReason === "customer-ended-call"`
- **Critical guard**: Must be NEW customer, not existing customer calling about service
- **Output fields**: `{ category: "booking-abandoned", hangupType: null, transferReason: null, spamType: null }`

#### 3. `booking-transferred` — NEW customer booking attempt forwarded to human
- **Signals**: AI asked booking questions (NEW consultation) + call was transferred
- **Required**: `endedReason === "assistant-forwarded-call"`
- **Output fields**: `{ category: "booking-transferred", hangupType: null, transferReason: "sales"|"estimate-scheduling", spamType: null }`

#### 4. `transferred` — Call forwarded without NEW booking intent
- **Signals**: `endedReason === "assistant-forwarded-call"` for any non-booking reason
- **Covers**: ALL existing customer calls (service, warranty, billing, installation scheduling, escalation)
- **Existing customer keywords**: "existing installation", "service", "warranty", "repair", "leak", "billing", "reschedule"
- **transferReason values** (client-configurable via `client.json`):
  - `sales` — New customer sales inquiry
  - `estimate-scheduling` — Schedule a consultation
  - `installation-scheduling` — Schedule an installation
  - `service-repair` — Existing customer service/repair
  - `billing` — Billing inquiry
  - `general` — General assistance
  - `escalation` — Requested supervisor/manager
  - `warranty-registration` — Warranty or registration

#### 5. `spam` — Non-genuine calls
- **spamType values**:
  - `short-call` — Duration < 5 seconds
  - `robocall-google-ads` — Keywords "Google ads", "Google Business" detected
  - `robocall-product` — Word "Product" appears before AI greeting
  - `wrong-number` — Caller didn't intend to reach the client
- **Output fields**: `{ category: "spam", hangupType: null, transferReason: null, spamType: "<type>" }`

#### 6. `hangup` — Customer hung up without booking attempt
- **Required**: `endedReason === "customer-ended-call"` AND duration >= 5s AND no booking questions asked
- **hangupType engagement sub-classification**:
  - `high-value` — 4+ conversational turns OR 90+ seconds OR specific project details mentioned
  - `moderate` — 3-6 turns AND 30-90 seconds
  - `low-value` — <3 turns OR <30 seconds
- **Output fields**: `{ category: "hangup", hangupType: "<type>", transferReason: null, spamType: null }`

---

### 4d. Post-Processing Override Chain (Applied After GPT Response)

After receiving GPT's classification, `enrich.js` applies deterministic overrides. These fire in order, and only when GPT returns an incorrect or `"unknown"` classification.

```
OVERRIDE 1 — appointmentBooked flag is authoritative
  IF call.appointmentBooked === true AND GPT.category !== "booking-completed"
  THEN → force category = "booking-completed"
  WHY: The structured output from Vapi is the most reliable booking signal.
        GPT sometimes misclassifies short post-booking hangups.

OVERRIDE 2 — endedReason-based fallbacks (only if GPT returned "unknown")
  IF GPT.category === "unknown":

    2a. IF endedReason === "assistant-forwarded-call"
        THEN → category = "transferred", transferReason = "other"

    2b. IF endedReason IN ("customer-ended-call", "silence-timed-out") AND duration < 10s
        THEN → category = "spam", spamType = "short-call"

    2c. IF endedReason IN ("customer-ended-call", "silence-timed-out") AND duration >= 10s
        THEN → category = "hangup"
        hangupType = duration < 30s ? "low-value" : "moderate"
```

**Derived field** (computed after final category is determined):
```
bookingStatus = category.startsWith("booking") ? "booking-attempt" : "none"
```

---

### 4e. Rule-Based Fallback Classifier (`core/lib/classify_call.js`)

This is a **separate, independent** classification engine used by report scripts as a secondary fallback when enrichment data is missing for a call. It operates on raw call data only (no GPT involved).

**Decision tree (evaluated top to bottom, first match wins):**

```
1. Duration < 5s
   → { category: "spam", transferReason: "short-abandoned" }

2. endedReason === "assistant-forwarded-call"
   → { category: "transferred", transferReason: call.destination.description }

3. Structured output "Appointment Booked" === true
   → { category: "booking-success" }

4. successEvaluation.call_success === "yes"
   OR successEvaluation.final_outcome includes "booked"/"scheduled"
   → { category: "booking-success" }

5. Confirmation phrases in transcript + assistant messages:
   - "appointment is confirmed for"
   - "consultation is confirmed for"
   - "your appointment is confirmed"
   - "your consultation is confirmed"
   → { category: "booking-success" }

6. Transfer intent found in toolCalls (intent_transfer/transfer_intent/transferCall)
   BUT endedReason !== "assistant-forwarded-call"
   → { category: "hangup", transferReason: "hung-up-during-transfer-to-{destination}" }
   (Customer hung up during the transfer attempt)

7. endedReason === "customer-ended-call"
   → { category: "hangup", transferReason: "customer-hung-up" }

8. endedReason === "assistant-ended-call"
   → { needs_analysis: true }  (requires GPT to determine)

9. All other cases
   → { needs_analysis: true }
```

**Key difference from GPT enrichment**: This classifier does NOT distinguish between `booking-abandoned` and `hangup`, nor does it assign `hangupType` sub-levels. It's a simpler, faster heuristic for when GPT enrichment hasn't run.

---

### 4f. Enrichment Storage Format

Enrichments are persisted by `core/lib/store_enrichment.js` in daily files, keyed by call ID.

**File**: `clients/lf01/data/enriched/vapi_enriched_YYYY-MM-DD.json`

**Structure** (one file per calendar day):
```json
{
  "call-id-abc123": {
    "callId": "call-id-abc123",
    "createdAt": "2026-02-03T14:30:00.000Z",
    "enrichedAt": "2026-02-03T15:00:12.345Z",
    "model": "gpt-4o-mini",
    "classification": {
      "category": "hangup",
      "hangupType": "moderate",
      "transferReason": null,
      "spamType": null,
      "bookingStatus": "none"
    }
  },
  "call-id-def456": {
    "callId": "call-id-def456",
    "createdAt": "2026-02-03T16:45:00.000Z",
    "enrichedAt": "2026-02-03T17:00:12.345Z",
    "model": "gpt-4o-mini",
    "classification": {
      "category": "booking-completed",
      "hangupType": null,
      "transferReason": null,
      "spamType": null,
      "bookingStatus": "booking-attempt"
    }
  }
}
```

**Merge behavior**: When saving new enrichments, existing enrichments in the same file are preserved. New entries overwrite old ones with the same call ID (safe re-enrichment).

**Deduplication**: Before enrichment runs, `getUnenrichedCalls()` filters out any call whose ID already exists in the enrichment Map. Pass `--force` to re-enrich all calls regardless.

---

### 4g. End-to-End Enrichment Sequence Diagram

```
┌─────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Raw Call    │   │ Pre-Process  │   │   GPT-4o     │   │ Post-Process │
│  JSON File   │──→│  Extract 5   │──→│  Classify    │──→│  Overrides   │──→ Enriched JSON
│              │   │  metadata    │   │  (batch 50)  │   │  (2 rules)   │
└─────────────┘   │  fields      │   │              │   │              │
                  └──────────────┘   └──────────────┘   └──────────────┘

   Fields extracted:              Prompt assembled from:      Override 1: appointmentBooked
   - duration                     - prompts.json templates    Override 2: endedReason fallback
   - endedReason                  - client.json context           (only if GPT → "unknown")
   - transferDestinationHint      - 6 classification rules
   - appointmentBooked            - call data (summary,
   - summary + transcript           transcript, metadata)
```

---

### 4h. Edge Cases & Known Behaviors

1. **Post-booking hangups**: Customer books appointment, then hangs up. Vapi records `endedReason: "customer-ended-call"` but `appointmentBooked: true`. Override 1 correctly forces `booking-completed` even though GPT might see "customer hung up" and classify as `hangup`.

2. **Successful transfer misclassified as booking**: Vapi's `successEvaluation` might report `call_success: "yes"` for a successful transfer (not a booking). The pre-processing guard specifically checks that `final_outcome` includes "appointment"/"consultation" AND does NOT include "transferred".

3. **Failed transfers**: Customer hangs up during transfer attempt. `toolCalls` show `intent_transfer` was invoked, but `endedReason !== "assistant-forwarded-call"`. The rule-based classifier catches this as `hangup` with reason `"hung-up-during-transfer-to-{destination}"`.

4. **Silence timeout**: `endedReason: "silence-timed-out"` is treated identically to `"customer-ended-call"` in the override chain — classified as spam (if <10s) or hangup (if >=10s).

5. **GPT API failure**: If the entire OpenAI API call fails (network error, rate limit, etc.), ALL calls in that batch get `category: "unknown"` with null sub-fields. The override chain then classifies what it can from `endedReason`.

6. **Transcript truncation**: Only first 500 characters of transcript are sent to GPT. For long calls, the `summary` field (AI-generated by Vapi) is the primary classification signal. The transcript serves as supplementary evidence.

7. **assistant-ended-call**: The rule-based classifier returns `{ needs_analysis: true }` for this case because it could be a polite decline, completed booking, or AI logic error. Only GPT can determine intent from the conversation content.

---

## 5. Scheduling Requirements

| Schedule | Type | Time (ET) | UTC | Airflow Equivalent |
|----------|------|-----------|-----|-------------------|
| Daily morning | DOD report | 5:00 AM | 10:00 | `schedule_interval="0 10 * * *"` |
| Mid-day | Intraday | 11:00 AM | 16:00 | `schedule_interval="0 16 * * *"` |
| Afternoon | Intraday | 3:00 PM | 20:00 | `schedule_interval="0 20 * * *"` |

**Note**: DOD fetches 2 days of data (`--days=2`) to compare today vs yesterday. Intraday fetches 1 day (`--days=1`).

---

## 6. Configuration System

### Per-Client Config Files (all JSON, no code changes needed)

```
clients/<client_id>/config/
├── client.json    — Business identity, phone numbers, services, email recipients, branding
├── prompts.json   — GPT prompt templates with {{placeholder}} variables
├── report.json    — Pricing ($0.79/min AI, $45/hr human), KPI targets, business hours
└── revenue.json   — Conversion rates, average project value for ROI calculations
```

### Config Loader (`core/config-loader.js`)
- `loadClientConfig(clientName)` → merges all 4 files into single config object
- Auto-creates data subdirectories: `raw/`, `enriched/`, `reports/`, `logs/`, `recordings/`, `openai_analysis/`
- Returns `config.client`, `config.prompts`, `config.report`, `config.revenue`, `config.paths`

### Adding a New Client
1. Copy `clients/lf01/` → `clients/<new_id>/`
2. Update all 4 config JSON files with new client's business details
3. Add schedule (Airflow DAG / workflow) for the new client
4. Add client-specific API keys as secrets

---

## 7. External Services & Secrets

| Secret | Service | Purpose | Required By |
|--------|---------|---------|-------------|
| `VAPI_API_KEY` | Vapi (api.vapi.ai) | Fetch call records | Task 1 (Fetch) |
| `OPENAI_API_KEY` | OpenAI API | GPT-4o-mini classification | Task 2 (Enrich) |
| `AZURE_TENANT_ID` | Azure AD | Service Principal auth | Task 4 (Email) |
| `AZURE_CLIENT_ID` | Azure AD | Service Principal auth | Task 4 (Email) |
| `AZURE_CLIENT_SECRET` | Azure AD | Service Principal auth | Task 4 (Email) |

---

## 8. Data Storage & File Conventions

### Directory Layout
```
clients/lf01/data/
├── raw/              vapi_calls_YYYY-MM-DD.json         ← Task 1 output
├── enriched/         vapi_enriched_YYYY-MM-DD.json      ← Task 2 output
├── reports/          EngAgent_DODReport_*_{TS}.md        ← Task 3 output
│                     EngAgent_DODReport_*_{TS}_meta.json
│                     intraday_report_*_{TS}.md
├── openai_analysis/  {TS}_hangup_analysis.json           ← Optional hangup analysis
├── recordings/       {callId}.wav                        ← Optional recording downloads
├── logs/             {script}_{TS}.log
└── metadata.json     ← Pipeline state tracking
```

### Metadata State File (`metadata.json`)
```json
{
  "lastFetchTimestamp": "2026-02-03T11:19:54.223Z",
  "lastFetchedCallId": null,
  "totalCallsStored": 24,
  "lastEnrichmentTimestamp": null,
  "totalCallsEnriched": 0
}
```

**Cloud migration consideration**: Replace file-based storage with blob storage (S3/GCS) or a database. The metadata.json state could become an Airflow XCom or a database row.

---

## 9. Supplementary Pipelines (Not in Main DAG)

These are run manually or on separate schedules:

| Script | Purpose | Command |
|--------|---------|---------|
| `scripts/report-weekly.js` | Weekly executive summary with ROI, heatmaps, lead CSV export | `node scripts/report-weekly.js --client=lf01 --week=YYYY-W##` |
| `scripts/analyze-hangups.js` | GPT analysis of hangup calls for lead qualification | `node scripts/analyze-hangups.js --client=lf01 --start=YYYY-MM-DD --end=YYYY-MM-DD` |
| `scripts/download-recordings.js` | Download call audio WAV files from Vapi | `node scripts/download-recordings.js --client=lf01 --days=7` |

---

## 10. Idempotency & Error Handling Summary

| Concern | Current Behavior | Production Recommendation |
|---------|-----------------|--------------------------|
| **Duplicate calls** | Deduplicated by call ID via Map merge | Keep — works well |
| **Duplicate enrichments** | Skips already-enriched calls (unless `--force`) | Keep — add Airflow task-level retry |
| **GPT failures** | Falls back to `"unknown"` + rule-based override | Add exponential backoff retry |
| **Email failures** | Single attempt, throws on failure | Add retry with dead-letter alerting |
| **Stale report detection** | `validateReportDate()` checks filename dates | Keep — good guard |
| **Re-runability** | All tasks safe to re-run | Leverage Airflow's built-in retry |
| **No automatic retries** | Manual re-trigger via GitHub Actions | Use Airflow `retries=3, retry_delay=timedelta(minutes=5)` |

---

## 11. Airflow DAG Skeleton (Conceptual)

```python
# Conceptual — adapt to your Airflow version and operators

from airflow import DAG
from airflow.operators.bash import BashOperator
from datetime import datetime, timedelta

default_args = {
    'retries': 3,
    'retry_delay': timedelta(minutes=5),
}

with DAG(
    'lf01_dod_report',
    schedule_interval='0 10 * * *',  # 5am ET
    default_args=default_args,
    catchup=False,
) as dag:

    fetch = BashOperator(
        task_id='fetch_vapi_calls',
        bash_command='node scripts/fetch.js --client=lf01 --days=2',
    )

    enrich = BashOperator(
        task_id='enrich_calls_gpt',
        bash_command='node scripts/enrich.js --client=lf01 --start={{ ds }} --end={{ ds }} --force',
    )

    report = BashOperator(
        task_id='generate_dod_report',
        bash_command='node scripts/report-day-over-day.js --client=lf01 --date={{ ds }}',
    )

    email = BashOperator(
        task_id='send_email_report',
        bash_command='node scripts/send-email.js --client=lf01 --type=dod --date={{ ds }}',
        # Note: email sending is currently embedded in scheduled-report.js
        # May need to be extracted into its own script for Airflow
    )

    fetch >> enrich >> report >> email
```

---

## 12. Key Files Reference

| File | Role |
|------|------|
| `scripts/scheduled-report.js` | Current orchestrator (fetch -> enrich -> report -> email). This is what Airflow replaces. |
| `scripts/fetch.js` | Vapi API ingestion |
| `scripts/enrich.js` | GPT classification |
| `scripts/report-day-over-day.js` | DOD report generation |
| `scripts/report-intraday.js` | Intraday report generation |
| `scripts/report-weekly.js` | Weekly executive report |
| `core/config-loader.js` | Multi-client config system |
| `core/prompt-builder.js` | GPT prompt template engine |
| `core/lib/classify_call.js` | Rule-based classification fallback |
| `core/lib/calculate_roi.js` | ROI/revenue computation |
| `core/lib/email-sender.js` | Branded HTML email via Microsoft Graph |
| `core/lib/export_leads.js` | Lead extraction and CSV export |
| `core/lib/generate_heatmap.js` | Call volume heatmap generation |
| `core/lib/store_enrichment.js` | Enrichment data read/write |
| `.github/workflows/_report-engine.yml` | Reusable GitHub Actions workflow template |
| `.github/workflows/lf01-reports.yml` | LeafFilter schedule definition |

---

## 13. Migration Considerations for Production Cloud

1. **Storage**: Replace local filesystem with S3/GCS/Azure Blob. All file I/O goes through `store_enrichment.js` and direct `fs` calls in each script — these are the refactor points.
2. **State**: Replace `metadata.json` with a database table or Airflow XComs for cross-task state.
3. **Secrets**: Move from `.env` / GitHub Secrets to a vault (AWS Secrets Manager, HashiCorp Vault, etc.).
4. **Email**: The Microsoft Graph integration can stay as-is, or migrate to SES/SendGrid if preferred.
5. **Monitoring**: Add Airflow alerting (on_failure_callback), Datadog/CloudWatch metrics for call counts and classification distribution.
6. **Extract email task**: Currently email sending is coupled inside `scheduled-report.js`. For Airflow, extract it into a standalone script so each DAG task is a single concern.
7. **Multi-client scaling**: One DAG per client, or a parameterized DAG with client ID as a config variable.
