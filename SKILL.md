---
name: recruiting-database-crud
description: Safely query or change recruiting and CRM records through the AI recruiting workbench authenticated business APIs. Use when Codex needs candidates, jobs, matches, customers, order leads, orders, activities, follow-ups, interviews, receivables, JD intakes, reply rules, roadmap requirements, or mirrored Feishu Base data.
---

# Recruiting Database CRUD

Operate through the workbench business API. Never open, copy, patch, or run SQL against `workbench.sqlite`.

## Workflow

1. Read [references/api-contract.md](references/api-contract.md) and select the domain endpoint.
2. Before the first operation in a runtime, call `GET /healthz` and stop if the database is not ready.
3. For updates or deletes, read the current record first and retain its version field when the endpoint requires one.
4. Treat create, update, archive, restore, and delete as writes. Proceed only when the user requested that mutation; otherwise use `--dry-run`.
5. Run `scripts/workbench-db`. Pass complex JSON through `--file` instead of shell interpolation.
6. Re-read the affected record or collection and report the confirmed result.

## Commands

```bash
scripts/workbench-db request GET '/api/candidates?q=Agent'
scripts/workbench-db request POST /api/candidates \
  --file /tmp/candidate.json --idempotency-key candidate-source-123 --confirm-write
scripts/workbench-db request PATCH /api/candidates/CANDIDATE_ID \
  --data '{"city":"上海"}' --confirm-write
scripts/workbench-db request DELETE /api/candidates/CANDIDATE_ID --confirm-write
scripts/workbench-db request POST /api/candidates/CANDIDATE_ID/restore --confirm-write
scripts/workbench-db request GET /api/dashboard
scripts/workbench-db request GET /api/crm/candidate-followups
scripts/workbench-db request POST /api/crm/activities \
  --file /tmp/activity.json --confirm-write --request-id activity-source-123
```

`--entry` accepts `skill`, `cli`, or `mcp` and defaults to `skill`. Direct terminal use should pass
`--entry cli`; an MCP adapter should pass `--entry mcp`. Every call carries a request ID, and callers
should provide a stable `--request-id` for traceable business writes.

Use `configure` only when the runtime has not already received `WORKBENCH_URL` and
`WORKBENCH_DATABASE_API_TOKEN`. Pipe the token through stdin so it never appears in shell history:

```bash
printf '%s' "$TOKEN" | scripts/workbench-db configure \
  --url https://your-workbench.example --token-stdin
```

## Safety

- Never print, return, commit, or attach the database token or private config file.
- Never call `/api/connector/`, `/api/candidate-ingest/`, `/api/public/`, or `/api/auth/` with this Skill.
- Candidate deletion means archive; use restore to reverse it.
- Job deletion requires `expected_updated_at` and may be blocked by delivery locks.
- Feishu Base mirror endpoints are read-only. Do not mutate the mirror as a substitute for writing Feishu.
- Preserve 409/428 conflicts. Re-read and resolve them; do not silently overwrite newer data.
- Matching scores, reminders, and generated copy remain suggestions from their owning Skills. This
  Skill records facts and confirmed choices; it does not reproduce recruiting algorithms.
