# SatQuery AI — Backend Architecture & Service File Breakdown

## 1. Overview & Tech Stack

The backend is an Express orchestrator service written in Node.js (ES Modules). It manages intent classification, task planning, input validation, tool execution against the Python ML service, MongoDB persistence, and answer composition.

- **Runtime**: Node.js 20+
- **Framework**: Express.js
- **Database**: MongoDB (Mongoose ORM)
- **Agent LLM Providers**: Groq (`llama-3.3-70b`), Anthropic (`claude-3-5-sonnet`), OpenAI (`gpt-4o-mini`)
- **Port**: `5010`

---

## 2. Directory Structure

```
backend/src/
├── index.js                     # Express server setup & middleware initialization
├── routes/
│   ├── query.js                 # Primary /api/query route handler
│   ├── images.js                # Image upload & tile registration handler
│   ├── tiles.js                 # Tile metadata retrieval handler
│   ├── ml.js                    # ML service proxy & health check
│   ├── tools.js                 # Tool registry metadata handler
│   ├── fetch-imagery.js         # GEE fetch-by-region handler
│   └── auth.js                  # User registration & JWT authentication
├── agents/
│   ├── pipeline.js              # Master agent orchestrator pipeline
│   ├── intentClassifier.js      # Natural-language intent classifier (LLM/heuristic)
│   ├── inputValidator.js        # Parameter & raster modality guardrails
│   ├── taskPlanner.js           # Multi-step tool execution planner
│   ├── toolExecutor.js          # HTTP executor calling ML service endpoints
│   ├── confidenceEstimator.js   # Scoring engine for confidence metrics
│   └── answerComposer.js        # Grounded answer composition engine
├── services/
│   ├── db.js                    # MongoDB connection manager
│   ├── mlServiceClient.js       # HTTP client for Python FastAPI service
│   ├── seedTools.js             # Initializer for ToolRegistry MongoDB collection
│   └── demoTrendService.js      # Fallback manager for trend precomputations
├── models/
│   ├── Tile.js                  # Mongoose schema for uploaded raster tiles
│   ├── Query.js                 # Mongoose schema for persistent user queries
│   ├── ToolRegistry.js          # Mongoose schema for tool registry definitions
│   ├── ResultsCache.js          # Mongoose schema for cached execution results
│   └── User.js                  # Mongoose schema for user accounts
├── middleware/
│   └── auth.js                  # JWT validation & anonymous user fallback
└── utils/
    ├── responseBuilder.js       # Standardized Trust Layer response builder
    ├── spectralAnalyzer.js      # Band metadata analyzer helper
    ├── semanticChangeInterpreter.js # Natural-language change threshold builder
    └── multiTemporalAnalyzer.js # Time-series trend helper
```

---

## 3. File-by-File Breakdown

### Core Entry & Server

- **`src/index.js`**: Server initialization entry point. Connects to MongoDB (`src/services/db.js`), seeds default tools (`seedTools.js`), attaches CORS, JSON, and URL-encoded body parsers, registers API routes under `/api/`, and starts HTTP server on port 5010.

### Agent Orchestration Pipeline (`src/agents/`)

- **`src/agents/pipeline.js`**: Master orchestrator function `runAgenticPipeline()`. Executes the 6-stage lifecycle:
  1. *Intent Classification*: Resolves `taskType`.
  2. *Input Validation*: Checks image counts, spatial co-registration, and band requirements.
  3. *Task Planning*: Generates execution plan.
  4. *Tool Execution*: Dispatches request to Python ML service.
  5. *Confidence Estimation*: Calculates numerical confidence score.
  6. *Answer Composition*: Produces final grounded text response.
  Returns complete Trust Layer payload and persists document to `queries` collection.

- **`src/agents/intentClassifier.js`**: Uses LLM function calling (Groq / Anthropic / OpenAI) to parse raw query text into structured intent (`VQA`, `NDVI`, `NDWI`, `CHANGE`, `AREA`, `TREND`, `OPTICAL_SAR`). Contains regex keyword fallback for offline execution.

- **`src/agents/inputValidator.js`**: Enforces strict modality guardrails:
  - Rejects single image queries when `CHANGE` or `OPTICAL_SAR` is requested.
  - Verifies presence of Red/NIR bands for `NDVI`.
  - Rejects optical-only pairs for `OPTICAL_SAR` (requires 1 optical + 1 SAR tile).

- **`src/agents/taskPlanner.js`**: Constructs ordered list of tool calls matching the classified task type and binds required arguments (tile paths, question string, parameters).

- **`src/agents/toolExecutor.js`**: Executes planned tool calls against the ML service client (`mlServiceClient.js`), measuring execution time and capturing status codes.

- **`src/agents/confidenceEstimator.js`**: Computes confidence score (0.0 to 1.0) using weighted factors: raster validation score, spatial overlap %, model status, and tool execution status.

- **`src/agents/answerComposer.js`**: Takes tool outputs and calls an LLM to generate a natural-language response strictly grounded in the tool results. Contains deterministic template fallbacks if LLM calls fail.

### API Routes (`src/routes/`)

- **`src/routes/query.js`**: Handles `POST /api/query`, `GET /api/query/history`, and `POST /api/query/trend` (two-phase cache resolution, then ML `/trend`). Parses user input, extracts session ID, triggers pipeline, and returns formatted response.
- **`src/routes/images.js`**: Handles `POST /api/images/upload`. Accepts multipart GeoTIFF/TIFF files via Multer, forwards files to ML service `/validate` endpoint, and saves valid tiles into MongoDB `Tile` collection.
- **`src/routes/tiles.js`**: Handles `GET /api/tiles` and `GET /api/tiles/:id`.
- **`src/routes/ml.js`**: Exposes `/api/ml/health` and `/api/ml/warmup` proxy routes.
- **`src/routes/tools.js`**: Lists available tools in the system registry.

### Services & Data Models (`src/services/` & `src/models/`)

- **`src/services/mlServiceClient.js`**: HTTP client managing REST requests to Python ML service (`http://localhost:8080`). Enforces configurable per-call timeouts (default 600s).
- **`src/models/Tile.js`**: MongoDB schema storing raster tile records: `filePath`, `filename`, `modality`, `format`, `resolution`, `crs`, `boundingBox`, `bands`.
- **`src/models/Query.js`**: MongoDB schema storing user query logs, session IDs, task types, confidence scores, execution traces, and evidence payloads.
- **`src/models/ToolRegistry.js`**: MongoDB schema storing registered tool capabilities and parameters.
