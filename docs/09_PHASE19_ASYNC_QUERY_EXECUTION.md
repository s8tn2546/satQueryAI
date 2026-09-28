# Phase 19 — Async Query Execution + Job Status API (Backend)

Status: **DONE** — all suites green.
Backend `npm test`: **36 suites / 495 passed** (35 / 476 before + 1 suite / 19 new).
ML `pytest`: **569 passed** (unchanged — ML service untouched this phase).

---

## 1. Objective

Long-running queries (VLM/VQA, caption, multi-tool chains) hold the request for
seconds-to-minutes. Phase 19 adds a real asynchronous path without disturbing
the existing synchronous contract:

- `POST /api/query?async=true` — accepts the request, persists a **job**, and
  returns `202 { jobId, jobStatus: 'queued' }` immediately without waiting on
  any ML work.
- `GET /api/query/status/:jobId` — poll target; returns the job's explicit
  state (`queued`/`running`/`completed`/`failed`), the job's **real pipeline
  stage**, and — when completed — the **exact same result object the synchronous
  path returns**, plus `queryId` linking to the persisted Query history record.
- The synchronous `POST /api/query` path is **unchanged in behavior**.

## 2. Scope and boundaries (explicit)

- **Backend + core pipeline only. No frontend changes.**
- **No Redis/Celery/BullMQ.** The smallest in-process bounded FIFO worker is
  used (env-tunable concurrency, default 1). Job *state* is durable in Mongo so
  clients survive without a broker; only the scheduling memory is process-local.
- **No duplicate pipeline logic.** The sync route and the async worker both call
  the same `executeQueryRequest()`; there is no second implementation.
- **Honest progress.** Stages are emitted only at real pipeline boundaries
  (`acquiring_data`, `validating`, `planning`, `running_analysis`,
  `generating_answer`, `completed`). **No percentages, no fabricated stages.**
- **No fabricated results.** A job whose tools fail completes with the same
  honest `status: 'failed'` response the sync path would produce; genuine
  internal errors mark the job itself `failed`.
- **Completed workstreams untouched** (AOI/ROI, LLM/answer composer, VLM
  prompt/token behavior, SAR, STAC, trend).
- **No secrets** added; `QUERY_JOB_CONCURRENCY` / `QUERY_JOB_TTL_HOURS` are the
  only new environment variables (optional, safe defaults).

## 3. What existed before

```
POST /api/query
  ├ inline validation (4 rejected branches -> 400)
  └ runAgentPipeline(queryText, imageRefs, parameters, { sessionId })
      ├ persisting a Query document (always)
      └ returning the full structured response (Section 6 contract)
      └ long-running work happened inside: Tile.find, classifyIntent,
        validateInputs, planTools, executeTools -> mlServiceClient.callMlService
        (HTTP to ML, default 600s timeout), composeAnswer
```

There was no job concept, no queue, no progress, no async acceptance. Long
queries held the HTTP request open for the whole pipeline.

## 4. What was built

### 4.1 Shared execution — `backend/src/services/queryExecution.js` (new)

- `parseQueryRequest(body)` — the historical inline validation, extracted
  byte-for-byte (identical 400 rejection bodies). Returns normalized `values`.
- `executeQueryRequest(body, { stageSink })` — validates then runs
  `runAgentPipeline` on the **same inputs the sync route used** (trimmed query
  text, validated refs, `{}` parameters). `stageSink` is optional and defaults
  to absent, so the sync path's behavior is unchanged.
- The sync route now calls `executeQueryRequest`; the async worker calls the
  exact same function. **One implementation.**
- `runAgentPipeline` gained an additive, optional `stageSink` (default no-op)
  that fires at real boundaries already present in the pipeline: after image
  acquisition, during task/input validation, after planning, before tool
  execution (`running_analysis`), and before answer composition. Trace and
  response payloads are untouched, so `stageSink` cannot change results.

### 4.2 Job model — `backend/src/models/QueryJob.js` (new)

- `jobId` — client-facing UUID (`crypto.randomUUID()`), unique, stable.
- `status` — `queued | running | completed | failed`.
- `stage` — free-form latest real pipeline stage (not an enum, so the pipeline
  can grow stages without migrations).
- `userId` / `sessionId` / `queryText` / `imageRefs` / `parameters` — the
  exact validated inputs the worker re-executes.
- `queryId` — the persisted `Query` document created by the pipeline (same one
  the sync path persists).
- `response` — the full sync-shaped result object embedded verbatim.
- `error` — a safe, single-line, truncated message (never a stack or secrets).
- `expiresAt` — TTL retention (default 24 h, `QUERY_JOB_TTL_HOURS`), reaped by
  the Mongo TTL index (`expireAfterSeconds: 0`), matching the `ResultsCache`
  pattern. This bounds stored responses; jobs that expired read back as the
  standard 404.

The `Query` model is **not modified** (its status enum stays
`success|partial|failed|rejected`); the job lifecycle lives separately.

### 4.3 In-process bounded worker — `backend/src/services/queryJobQueue.js` (new)

- FIFO queue + `pump()` enforcing `active < concurrency` (default 1,
  max 4, `QUERY_JOB_CONCURRENCY`). One job at a time mirrors the ML service's
  single-model serialized inference reality and guarantees `/health` and status
  polling are never starved (proven by test).
- `runJob`: atomically claims the job (`status: 'queued' -> 'running'`),
  executes `executeQueryRequest` with a `stageSink` that persists the real
  stage, then `completed` (with embedded response + `queryId`) or `failed`
  (with a safe error) on genuine thrown errors.
- **No re-execution on restart:** `reconcileStaleJobs()` marks every job left
  `queued`/`running` by a previous process as `failed` with an explicit
  "Backend restarted" error. Called once from `index.js startServer()` after
  `connectDB()`. It is deliberately **not** invoked lazily inside the queue so a
  freshly enqueued job can never be mislabeled stale.
- The pipeline's own failure surface (ML error / empty tools / all tools failed)
  is handled *inside* the pipeline as before, so those jobs **complete** with a
  `status: 'failed'`/`'partial'`/`'rejected'` response — mirroring the sync path
  exactly. Only exceptions escaping the pipeline mark the **job** `failed`.

### 4.4 Routes — `backend/src/routes/query.js`

- `POST /api/query?async=true` (or `=1`): runs the **same validation**; a
  rejection returns the identical 400 body (no job created); otherwise persists
  the job (capturing `req.user._id` when authenticated) and returns
  `202 { jobId, jobStatus: 'queued', stage: 'queued' }` — the caller holds the
  request open only for the duration of one Mongo insert.
- `GET /api/query/status/:jobId` — **registered before the `/:id` routes**, so
  it can never be shadowed. Returns:
  - `queued`/`running`: `{ jobId, jobStatus, stage, createdAt, startedAt }`.
  - `completed`: the full sync result fields **plus** job bookkeeping
    (`jobId`, `jobStatus`, `stage`, `queryId`, timestamps) — nothing from the
    pipeline response is overwritten.
  - `failed`: `{ jobId, jobStatus, stage, timestamps, error }` (HTTP 200 — the
    failed state is a readable state, not a transport error).
  - unknown: `404 { status: 'failed', error: 'Job not found' }`.
- Ownership: jobs created by an authenticated user are only pollable when the
  requester's JWT matches `userId` (mismatch/anonymous → 404). Anonymous jobs
  follow the repository's existing `/api/query/:id` convention — possession of
  the unguessable `jobId` is the credential (documented limitation).
- The **synchronous path is now `executeQueryRequest` + `res.json`** — same
  results, same statuses, same 400s, same 500 catch.

## 5. API contract

```
POST /api/query?async=true
  Body:  { queryText, imageRefs?, parameters?, sessionId? }   (as sync)
  202:   { jobId, jobStatus: "queued", stage: "queued" }
  400:   identical rejection contract as POST /api/query

GET /api/query/status/:jobId
  200 queued/running: { jobId, jobStatus, stage, createdAt, startedAt? }
  200 completed:      { ...<exact sync response>, jobId, jobStatus: "completed",
                        stage: "completed", queryId, createdAt, startedAt, completedAt }
  200 failed:         { jobId, jobStatus: "failed", stage: "failed",
                        createdAt, startedAt, completedAt, error }
  404:                { status: "failed", error: "Job not found" }
```

Job statuses: `queued`, `running`, `completed`, `failed`.
Job stages (real pipeline boundaries only): `queued`, `acquiring_data`,
`validating`, `planning`, `running_analysis`, `generating_answer`, `completed`.

## 6. Verification

### Test suite — `backend/tests/async-query.test.js` (19 tests)

1. **Sync preserved** — `POST /api/query` still returns the full 200 contract
   and the unchanged 400 rejection shape.
2. **Async acceptance** — `?async=true` returns `202` with `jobId`/`jobStatus`
   in well under the ML call horizon (measured against a *gated* mock, proving
   the 202 does not wait on the pipeline).
3. **Eager validation** — empty query / malformed refs → 400, same body, and
   **no job document is created**.
4. **Honest states** — polling reveals `running` with a real stage and **no**
   synthetic `progress`/`percentage` fields.
5. **Completed contract parity** — fields match the sync result; `queryId`
   resolves through `GET /api/query/:id`; an async run and a sync run under
   identical (mocked) inputs produce the same answer/taskType/result/evidence/
   confidence/status.
6. **Failures honest** — ML rejection → job **completes** with `status:
   "failed"`, zero result, and an explicit failed trace entry (never a
   fabricated success).
7. **Bounded concurrency** — with concurrency 1, while the first job is gated in
   `running_analysis`, the second stays `queued` and **at most one ML call is in
   flight**; both then complete.
8. **Restart recovery** — stale `queued`/`running` docs are marked `failed` by
   `reconcileStaleJobs()` with the restart message, their responses removed, and
   are **never re-executed**; a job enqueued after recovery still runs.
9. **Job-level failure rendering** — a `failed` job returns explicit state/error
   via the status endpoint.
10. **Ownership** — authenticated jobs: anonymous poll → 404, another user
    → 404, owner → 200; anonymous jobs stay reachable by jobId.
11. **Non-blocking** — `/health` responds `200` while a job is gated running.
12. **Retention** — every job carries `expiresAt` 24 h (±1 h) in the future
    (TTL bounded; reaped by Mongo, same pattern as `results_cache`).

### Full suites

- Backend `npm test`: **36 suites / 495 passed** (was 35 / 476).
- ML `pytest`: **569 passed** (unchanged — no ML files touched).

## 7. Design decisions (why)

| Decision | Rationale |
| --- | --- |
| In-process FIFO worker, no broker | No Redis/BullMQ exists here; smallest reliable bounded option. Job state durable in Mongo; only scheduling memory is process-local. |
| Separate `QueryJob` model | `Query` status enum must not grow job states (would churn history contract/tests). Job lifecycle + embedded result keeps history intact. |
| Both paths call `executeQueryRequest` | Single source of truth for "run a query"; sync and async cannot drift. |
| Stage sink inside `pipeline.js` (additive) | Real boundaries exist there; adding an *optional* callback touches no other module and cannot alter output when unused. |
| Honest `failed`-job only on pipeline escape | ML/tool failures are already handled inside the pipeline → those jobs `completed` with `status:'failed'` (same as sync). Only genuine escapes fail the job. |
| Embed the full response | Completed jobs byte-match a sync response; clients reuse one parsing path. `queryId` connects to existing history. |
| Eager input validation on async POST | Cheap, same 400s as sync, and invalid requests never create jobs. |
| 200 for a failed job's status | A failed state is readable state; 404 is reserved for "never existed". |
| `stage` is a plain string | Pipeline can introduce stages later without a schema migration. |
| TTL retention | Bounded storage; reaps asynchronously via Mongo's TTL monitor (documented, like `results_cache`). |

## 8. Known limitations (explicit)

- **No cancellation endpoint** (`cancelled` is not implemented) — out of scope.
- **No progress percentages** — only real stages; intentionally never invented.
- **Anonymous jobs are addressable by jobId** — matches the existing
  `/api/query/:id` convention; documented rather than silently changed.
- **Scheduling memory is process-local** — on restart, *jobs* survive in Mongo
  but are marked `failed`; they are never silently re-run (no duplicated
  execution), by design.
- In-flight jobs do not survive a deploy mid-run; acceptance (`202`) is fast, so
  the window is sub-second per request.