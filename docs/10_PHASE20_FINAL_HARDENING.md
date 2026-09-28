# Phase 20 — Final Hardening (Backend + ML Service) + Code-Freeze Preparation

Status: **DONE** — all suites green.
Backend `npm test`: **37 suites / 506 passed** (36 / 495 before; +1 suite / +11 new
regression tests, plus the anonymous-history contract test updated).
ML `pytest`: **569 passed** (unchanged suite; new behavior verified by re-running
every test against the hardened code).
Live smoke: backend + ML servers booted locally; `/health`, CORS allowlist,
security headers, JSON 404, `400` anonymous-history-without-sessionId all verified
by hand (`docs` screenshot-less; commands in Section 8).

---

## 1. Objective

Fix the P0/P1 findings of a repo-wide hardening audit and leave every long-running
workstream untouched. Scope was backend + ML service + infra/config validation
**only** — no frontend changes, no new analytics, no redesign.

## 2. Scope and boundaries (explicit)

- **Backend + ML service + repository docs/config only. No frontend changes.**
- **Completed workstreams untouched**: AOI/ROI, LLM/AnswerComposer, VLM
  prompt/token behavior, SAR analytics, STAC acquisition, trend, async jobs.
- **No fake security claims.** Everything below is "demo-ready / live-config
  pending", never "production-proven". Startup emits warn-only config checks.
- **No secrets added or committed**; no live external verification was performed
  (no live GEE, live STAC, or real model-weight inference in CI).
- **Existing tests were preserved**, not weakened; where a test asserted the old
  insecure behavior (the P0 history dump) it was updated to the new contract.

## 3. What existed before (the audit findings, P0/P1)

Backend:
- `GET /api/query/history` accepted **anonymous unscoped reads** → dumped every
  stored query (P0).
- `GET /api/query/:id` and `/:id/report` were readable by **any** anonymous caller
  with an id (P0).
- CORS was permissive (`allow_origins=["*"]` + credentials or `.cors()`), plus no
  helmet, no body-size limits, no rate limiting (P1).
- One shared dev JWT secret was hard-wired as a fallback that **tests and
  non-prod shipped with** (P1).
- Uploads leaked local `filePath`/`image_path` in responses and stored
  attacker-supplied filenames (P1).
- Many 500s echoed raw `err.message` (paths, keys, GEE URLs) to the client (P1).

ML service:
- CORS `["*"]` **with** `allow_credentials=True` (P1).
- 20+ `str(exc)` sites surfaced paths/URLs to clients (P1).
- Uploads were fully buffered with no Content-Length pre-check and
  `FileTooLargeError` was never caught → 500 (P1).
- GEE `getDownloadURL` downloads built a Bearer header but **never attached it**
  to the request (P1, functional bug).
- `adapter_used` was derived from `Path.exists` at request time, not from the
  loaded model (P1, honesty).
- Warmup response leaked the adapter filesystem path (P1).

Repo:
- README claimed a **live VQA "verified with LoRA adapter active"** result (overreach).
- `docker-compose.yml` pinched a default `JWT_SECRET` under `NODE_ENV=production`.
- `.env.example` files did not document the hardening knobs.

## 4. Backend changes

Configuration (`backend/src/config.js`, new):
- `NODE_ENV` + `isProduction()`; `resolveJwtSecret()` — production **throws** when
  `JWT_SECRET` is unset; development uses a long, clearly-labelled dev-only
  constant. `assertStartupConfig()` is called from `startServer()` (not at import,
  so tests import `app` freely).
- `corsOrigins()` from `CORS_ORIGINS` (comma-separated; defaults to local frontend
  dev ports); `trustProxySetting()` from `TRUST_PROXY`.

`backend/src/index.js`:
- `x-powered-by` off; CORS allowlist (disallowed origin → **no** ACAO header,
  `credentials: false`); helmet (`crossOriginResourcePolicy`) with CSP off.
- `express.json({ limit: '2mb' })` + `urlencoded({ limit: '1mb' })`.
- Conditional `trust proxy` behind `app.set('trust proxy', ...)`.
- Global `/api` rate limiter (default 300/min) with stricter ones on
  `/api/auth` (30), `/api/query` (60), `/api/images/upload` (30); all skip
  `/health` and `NODE_ENV=test`.
- JSON 404 (`Route not found.`) and a central error handler (413 entity.too.large
  → "Payload too large.", 400 entity.parse.failed, 429, generic 500 with **no**
  stack/raw messages).
- `startServer()` validates config, warns outside production, exits(1) on server
  errors, and does graceful SIGTERM/SIGINT shutdown (`disconnectDB()` + 10s
  watchdog). The import-safe guard (`NODE_ENV !== 'test'` + `argv[1]` matches)
  and `export default app` are preserved.

Auth / ownership:
- `auth.js` resolves the secret per-request; invalid token → anonymous with
  `req.authError = 'invalid_token'`; unknown user → `'unknown_user'`.
- History contract (changed): anonymous `GET /api/query/history` **without**
  `sessionId` → `400`; anonymous-with-sessionId filters `{ sessionId, userId: null }`;
  authenticated filters `{ userId: req.user._id }` (optionally + sessionId).
- `/:id` and `/:id/report` use `loadOwnedQuery()`: userId-set docs are
  owner-only; non-owners/anonymous get a plain 404 (no existence disclosure);
  anonymous-created docs keep possession-of-id semantics.
- `userId` threaded through sync request → `executeQueryRequest()` → pipeline (all
  5 `Query.create` calls) and through the async job queue worker.

Uploads (`routes/images.js`):
- multer `fileFilter` (allowlisted extension **and** mimetype via
  `ALLOWED_UPLOAD_MIMES`), server-generated sanitized stored filenames
  (`safeStoredExt()`, `[a-z0-9]{1,6}`), multer limits (5 files, 10 fields, 500MB),
  multi-file partial-failure rollback (tiles + files deleted), responses use the
  shared `publicTile`.
- Decision recorded: the audit's "always-run magic-byte signature check" was **not**
  added — it would break existing tests that upload fake bytes with a mocked ML
  "valid" verdict; the signature gate remains the ML-down fallback. Contributing
  safety comes from the multer-layer type/ext checks + limits + rollback.

Error/no-leak:
- New shared `backend/src/utils/publicTile.js`; `tiles.js`, `stac.js` `images.js`
  now only expose `storedFile`/preview booleans and never a path.
- `tools.js`, `stac.js`, `ml.js`, `mlServiceClient.js` return generic 500s.
- Pipeline `parameter_extraction` trace capped at 1000 chars; `tile_fetch_error`
  trace detail generic.

## 5. ML service changes

CORS / headers / limits (`app/main.py`):
- CORS allowlist from `CORS_ORIGINS` (default local frontend dev origins),
  `allow_credentials=False`; a `"*"` entry is dropped with a warning.
- Security-header middleware (nosniff, `X-Frame-Options: DENY`, no-referrer,
  restrictive permissions policy).
- Optional `ALLOWED_HOSTS` → `TrustedHostMiddleware` when configured.
- Opt-in in-memory rate limiting via `ML_RATE_LIMIT_ENABLED` + `ML_RATE_LIMIT_MAX`
  / `ML_RATE_LIMIT_WINDOW` (off by default so behavior is unchanged unless opted
  in).
- Warn-only startup config checklist (missing GEE/STAC/adapters, wildcard CORS).

Error redaction (`app/common/safe_errors.py`, new):
- `safe_error(exc)` preserves an exception's wording while scrubbing absolute
  paths → `[path]` and URLs → `[url]`, truncating to 250 chars, with a generic
  fallback.
- Applied at **every client-facing exception site**: `api/{area,caption,change,
  fetch_imagery,ndvi,ndwi,optical_sar,stac,trend,vqa}`, `http_utils`
  (`aoi_error_output`, upload-read), `geospatial/raster_io` (validate reason),
  `tools/roi_crop` (AOI report reasons), `services/gee_client` (auth/init/export).
- Tool-internal `raise XError(str(exc))` chains are redacted at the API boundary,
  so no path/URL detail ever reaches a response.

Uploads:
- `read_upload_file` now rejects an oversize upload from the declared
  Content-Length (`file.size`) **before** buffering, then re-checks after read.
- `FileTooLargeError` now subclasses `InvalidFileError`, so every endpoint's
  existing `except InvalidFileError` handles it (previously an uncaught 500).
- The read-failure detail (`: {exc}`) is dropped from the client message.

VLM:
- `adapter_in_use()` in `vlm_loader.py` reports whether the **loaded cached model**
  is a `PeftModel`; `adapter_used` in `/vqa` + `/caption` metadata now reflects the
  model that actually ran, not a `Path.exists()` guess.
- Warmup response no longer includes `adapter_path`; it returns
  `adapter_configured` + `adapter_active`.

GEE functional bug:
- `_download_pair` now attaches the OAuth Bearer token via an explicit
  `urllib.request.Request` (previously the header was built but `urlretrieve`
  never sent it), and `GEE ... failed: {exc}` wrappers no longer echo raw errors.

## 6. Repository / config

- `README.md`: the "Live VQA verification" claim was retracted to an honest
  "live-configuration status" (adapter active **only** when actually loaded; no
  accuracy claims); the stale "CORS is permissive" Security bullet was replaced
  with the allowlist/owner-scope reality.
- `docker-compose.yml`: no baked `JWT_SECRET` default (backend runs
  `NODE_ENV=production`, which now aborts without a real secret); ML service gains
  `CORS_ORIGINS` / `ALLOWED_HOSTS` / `ML_RATE_LIMIT_*` passthroughs.
- `.env.example` (backend + ML): documents `CORS_ORIGINS`, `TRUST_PROXY`,
  `ALLOWED_HOSTS`, the rate-limit knobs, and the production JWT requirement.
- ML `Dockerfile` context: new `.dockerignore` keeps local `.env`, fixtures,
  adapters, `.venv`, and training artifacts out of images.

## 7. Security-model notes (be precise)

- **Still anonymous-usable by design**: the app is demo-oriented; anonymous
  queries work with a client-generated `sessionId`. What changed is scoping:
  anonymous data is never listed without a sessionId and owner-created docs are
  never readable by others.
- **Rate limiting**: backend default-on (skipped under `NODE_ENV=test`); ML opt-in
  (off by default). Both are in-process, single-instance — documented as such,
  not a distributed throttle.
- **Dev JWT secret** is only honored when `NODE_ENV !== 'production'`; it is
  present so local dev/test boots without env. Production refuses to run without
  `JWT_SECRET`.
- **Not addressed (documented, low/infra)**: ML API-key auth on endpoints,
  ML non-root Docker user, GEE/temp-file GC, STAC fixture gate migration, multer
  2.x upgrade. All are config/infra-level, not correctness blockers for the
  demo-freeze.

## 8. Verification

Automated:
- Backend: `npm test -- --silent` → **506 passed / 37 suites**. New
  `backend/tests/security-hardening.test.js` (11 tests: CORS allowlist, helmet +
  no `x-powered-by`, JSON 404, 413 oversized body, upload no-filePath-leak +
  multi-file rollback with zero orphaned tiles, anonymous-history 400,
  owner-only `/:id` + `/:id/report`, anonymous-created docs keep possession-of-id).
  One test updated to set `process.env.JWT_SECRET` explicitly (no
  `default-dev-secret` dependency).
- ML: `.venv/bin/python -m pytest -q` → **569 passed**. (Behavior preserved for
  all expected reason strings — e.g. "geographic", "torch missing", "no torch",
  "adapter exploded" — because `safe_error` keeps controlled wording.)

Live smoke (this phase, local):
```
uvicorn app.main:app --port 8000            # /health ok; startup warns re GEE/STAC
curl POST /validate -F file=test_ndvi.tif  -> valid=true (real raster read)
OPTIONS /ndvi  (Origin: http://localhost:5173)      -> access-control-allow-origin reflected
OPTIONS /validate (Origin: https://evil.example.com)-> no access-control-allow-origin
GET /health -> x-content-type-options, x-frame-options, referrer-policy, permissions-policy
node src/index.js (PORT=5055, NODE_ENV=development)  -> /health ok, seeded 11 tools
GET /api/query/history                    -> 400
GET /api/query/history?sessionId=smoke-test -> 200
GET /api/nope                             -> {"status":"failed","error":"Route not found."} [404]
```

Known risk: one rare in-band flake in `backend/tests/async-query.test.js`
("Job not found" timeout) passed on isolation and on re-runs; treat any recurrence
as a timing issue, not a regression.

## 9. Demo-freeze posture

Everything is committed-ready but **nothing is committed yet** (working tree
carries all Phase 20 changes uncommitted by design). The demo remains fully
functional in dev mode; for a real deployment set `JWT_SECRET`, `MONGODB_URI`,
`CORS_ORIGINS`, and the ML `CORS_ORIGINS`/GEE/STAC values, then run both test
suites once more.