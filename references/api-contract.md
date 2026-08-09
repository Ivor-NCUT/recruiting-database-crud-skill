# Workbench database API

Use only the private business endpoints below. The database service token is intentionally rejected by
Connector, candidate-ingestion, public-share, and authentication endpoints.

## Resources

| Resource | Read | Create | Update | Delete / restore |
|---|---|---|---|---|
| Candidates | `GET /api/candidates`, `GET /api/candidates/:id` | `POST /api/candidates` | `PATCH /api/candidates/:id` | `DELETE /api/candidates/:id` archives; `POST /api/candidates/:id/restore` restores |
| Candidate parse tasks | `GET /api/candidate-ingest/parse-tasks/:id` | `POST /api/candidate-ingest/parse-tasks` | — | — |
| Candidate duplicates | `GET /api/candidate-duplicates` | — | `POST /api/candidate-duplicates/:id/resolve` | — |
| Jobs | `GET /api/jobs`, `GET /api/jobs/:id` | Submit `POST /api/jd-intakes`; parsing creates jobs asynchronously | `PATCH /api/jobs/:id` | `DELETE /api/jobs/:id` with `{"expected_updated_at":"..."}` |
| JD intakes | `GET /api/jd-intakes` | `POST /api/jd-intakes` | — | `DELETE /api/jd-intakes/:id` while pending |
| Matches | `GET /api/matches`, `GET /api/matches/:id` | `POST /api/match-runs` | `PATCH /api/matches/:id` or bulk `PATCH /api/matches` | No direct delete |
| Reply rules | `GET /api/reply-rules` | `POST /api/reply-rules` | `PATCH /api/reply-rules/:id` | `DELETE /api/reply-rules/:id` |
| Roadmap | `GET /api/roadmap` | `POST /api/roadmap` | `PATCH /api/roadmap/:id` with `If-Match: "<updatedAt>"` | No delete |
| Feishu Base mirror | `GET /api/lark-base/tables`, `GET /api/lark-base/tables/:tableId/records` | — | — | — |
| CRM cockpit | `GET /api/dashboard` | — | — | — |
| CRM customers | `GET /api/crm/companies`, `GET /api/crm/companies/:id` | `POST /api/crm/companies` | `PATCH /api/crm/companies/:id` | `DELETE /api/crm/companies/:id`; `POST .../restore` |
| CRM order leads / orders | `GET /api/crm/order-leads`, `GET /api/crm/orders` | `POST /api/crm/order-leads`; `POST .../convert` | `PATCH /api/crm/order-leads/:id`, `PATCH /api/crm/orders/:id` | reversible archive / restore endpoints |
| CRM activities | `GET /api/crm/activities`, `GET .../versions` | `POST /api/crm/activities` | `PATCH /api/crm/activities/:id` | `DELETE ...`; `POST .../restore` |
| Candidate follow-up | `GET /api/crm/candidate-followups`, `GET /api/crm/candidates/:id` | `POST /api/crm/candidate-order-links` | `PATCH /api/crm/candidates/:id` | — |
| Interview CRM | `GET /api/crm/interviews`, `GET /api/crm/interviews/:id` | `POST .../drafts` | `PATCH /api/crm/interviews/:id`, `PATCH .../interview-drafts/:id` | — |
| Receivables | `GET /api/crm/receivables` | `POST .../reminders`, `POST .../postpone`, `POST .../settle` | — | — |

## Query parameters

- Candidates: `q`, `status`, `include_archived=true`.
- Jobs: `q`, `company`, `category`, `fee_sort=asc|desc`.
- Matches: `q`, `status`, `job_id`.
- Candidate duplicates: `status`.

## Write rules

- Send JSON and use `--confirm-write`.
- Supply a stable `--idempotency-key` for candidate creation or ingestion derived from the source record.
- Candidate parse tasks use the candidate-ingestion token and accept an HMAC `candidateIdentityKey`,
  uploaded `fileIds`, optional `text`, `portfolio`, and `referrerName`. Completed tasks return the
  candidate, evidence, and up to ten open-job matches from `job-resume-intelligent-matching-fanhan`.
- Read a candidate/job/roadmap record before changing it.
- Candidate identities, resume hashes, and source email IDs may merge into an existing master record.
- Candidate archive is the reversible deletion path.
- Job delete can return `409` when a delivery is locked or `expected_updated_at` is stale.
- Roadmap update returns `428` without `If-Match` and `409` for a stale version.
- Treat every non-2xx response as uncommitted until a follow-up read proves otherwise.
- Send `x-workbench-entry: skill|cli|mcp` and `x-request-id` (the CLI flags are `--entry` and
  `--request-id`). CRM audit records retain the Agent entry identity, request ID, and before/after facts.

## Data boundary

The Feishu Base tables are a lossless read mirror. Clients must write to the owning domain API or to
Feishu through `lark-cli`; never patch mirror rows directly.
