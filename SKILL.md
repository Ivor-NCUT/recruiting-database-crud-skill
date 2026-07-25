---
name: recruiting-database-crud
description: Safely query, create, update, archive, restore, or delete records in the AI recruiting workbench through its authenticated business APIs. Use when Codex needs to inspect or change candidates, jobs, matches, JD intakes, reply rules, roadmap requirements, or mirrored Feishu Base data in the local or cloud recruiting database.
---

# Recruiting Database CRUD

Operate through the workbench business API. Never open, copy, patch, or run SQL against `workbench.sqlite`.

## Workflow

1. Read [references/api-contract.md](references/api-contract.md) and select the domain endpoint.
2. Before the first operation in a runtime, call `GET /healthz` and stop if the database is not ready.
3. For updates or deletes, read the current record first and retain its version field when the endpoint requires one.
4. Treat create, update, archive, restore, and delete as writes. Proceed only when the user requested that mutation; otherwise use `--dry-run`.
5. Run `scripts/workbench_db.py`. Pass complex JSON through `--file` instead of shell interpolation.
6. Re-read the affected record or collection and report the confirmed result.

## Commands

```bash
python3 scripts/workbench_db.py request GET '/api/candidates?q=Agent'
python3 scripts/workbench_db.py request POST /api/candidates \
  --file /tmp/candidate.json --idempotency-key candidate-source-123 --confirm-write
python3 scripts/workbench_db.py request PATCH /api/candidates/CANDIDATE_ID \
  --data '{"city":"上海"}' --confirm-write
python3 scripts/workbench_db.py request DELETE /api/candidates/CANDIDATE_ID --confirm-write
python3 scripts/workbench_db.py request POST /api/candidates/CANDIDATE_ID/restore --confirm-write
```

Use `configure` only when the runtime has not already received `WORKBENCH_URL` and
`WORKBENCH_DATABASE_API_TOKEN`. Pipe the token through stdin so it never appears in shell history:

```bash
printf '%s' "$TOKEN" | python3 scripts/workbench_db.py configure \
  --url https://your-workbench.example --token-stdin
```

## Safety

- Never print, return, commit, or attach the database token or private config file.
- Never call `/api/connector/`, `/api/candidate-ingest/`, `/api/public/`, or `/api/auth/` with this Skill.
- Candidate deletion means archive; use restore to reverse it.
- Job deletion requires `expected_updated_at` and may be blocked by delivery locks.
- Feishu Base mirror endpoints are read-only. Do not mutate the mirror as a substitute for writing Feishu.
- Preserve 409/428 conflicts. Re-read and resolve them; do not silently overwrite newer data.
