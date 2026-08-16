# Webhook Automation Runner

A self-hostable tool that runs small automations — triggered by a webhook or a
schedule — with a visual editor and a run history that tells you exactly what
happened.

## Status: Phase 3 — editor and run history UI

Phases 1 (engine + schema) and 2 (REST API + persistence) are done and
untouched by Phase 3. Phase 3 adds a React + TypeScript frontend (`web/`)
with a React Flow canvas: build a workflow visually, save it, trigger it,
and watch a run complete with per-node status colored directly on the
canvas — the failure case is the point (see below).

```
src/                   Backend — unchanged shape from Phase 2, routes now under /api
  db/
    schema.ts        Drizzle schema: workflows, nodes, edges, runs, node_executions
    client.ts         Postgres connection (drizzle-orm/postgres-js), reads DATABASE_URL
    repository.ts      All queries, incl. updateWorkflow (full replace) added in Phase 3
  engine/              Unchanged from Phase 1 — see below
  api/
    app.ts             Express app: cors, JSON body parsing, routes, static frontend + SPA fallback, error handler
    server.ts           Entrypoint: starts the HTTP server and the job loop
    routes/
      workflows.ts       /api/workflows: create/list/get/update, trigger, list runs
      runs.ts             /api/runs/:id
      webhooks.ts         /webhooks/:workflowId — unprefixed, handed to external services
  jobs/
    processor.ts        claimNextPendingRun + executeWorkflow + persist, on a poll loop
tests/
  plan.test.ts / engine.test.ts / executors.test.ts   (Phase 1, DB-free)

web/                   Frontend — React + TypeScript + Vite + React Flow
  src/
    api.ts               Typed fetch wrapper for the backend's /api/* routes
    types.ts              Shared shapes matching the backend's JSON responses
    App.tsx                Routes: /, /workflows/new, /workflows/:id/edit, /workflows/:id
    components/FlowNode.tsx  Custom React Flow node — renders type/name/run-status color
    pages/
      WorkflowListPage.tsx    Lists workflows, links to detail/new
      WorkflowEditorPage.tsx  Canvas: add/configure/connect nodes, save (create or update)
      WorkflowDetailPage.tsx  Read-only canvas colored by a selected run, run history,
                                per-node input/output/error inspector, "Run now"
```

### Running the tests

```
npm install
npm test        # 42 Vitest tests, no database required
npm run typecheck
```

### Running in development

```
npm run db:push          # apply src/db/schema.ts to DATABASE_URL (see .env.example)
npm run dev               # backend: REST API + job loop on $PORT (default 4000)

cd web && npm install
npm run dev                # frontend: Vite dev server on :5173, proxies /api, /webhooks,
                            # /health to :4000 (see web/vite.config.ts)
```

Open `http://localhost:5173`.

### Running as it would in production

```
npm run build   # tsc for the backend, then builds web/ too (root package.json)
npm start        # one process, one port: serves the API and the built frontend
```

Open `http://localhost:$PORT` (default 4000) — no separate frontend origin,
no `VITE_API_URL` to set. See "Deploying" below.

### The REST API

All routes are under `/api` **except** `/webhooks/:id` (handed to external
services, kept short) and `/health`. The prefix exists specifically so these
don't collide with the frontend's own `/workflows/:id`-shaped routes — a
plain `/workflows/:id` was ambiguous between "give me the JSON" (backend)
and "render the detail page" (frontend SPA route), which broke on any hard
navigation or refresh once the frontend existed.

| | |
|---|---|
| `POST /api/workflows` | Create a workflow: `{ name, description?, nodes: [{ id, type, name, config }], edges: [{ id, source, target, branch? }] }`. Node/edge ids are caller-supplied strings, unique per workflow. |
| `PUT /api/workflows/:id` | Full replace — same body shape as create. What the editor's "Save" calls when editing an existing workflow. |
| `GET /api/workflows` | List workflows. |
| `GET /api/workflows/:id` | A workflow with its nodes and edges. |
| `POST /api/workflows/:id/trigger` | Manual "Run now" — body becomes the trigger payload. Enqueues a `run`, returns `202`. |
| `GET /api/workflows/:id/runs` | Runs for a workflow, newest first. |
| `GET /api/runs/:id` | A run with all of its `node_executions` — input, output, error, duration per node. |
| `DELETE /api/workflows/:id` | Deletes a workflow. Cascades to its nodes, edges, runs, and node_executions. `204` on success. |
| `DELETE /api/workflows/:id/runs` | Clears run history — `succeeded`/`failed` runs only, `pending`/`running` are left alone. Returns `{ deleted: <count> }`. |
| `POST /webhooks/:workflowId` | The webhook trigger. Same enqueue path as manual trigger, `triggerType: "webhook"`. |

### How a run actually executes

`POST /webhooks/:id` (or `.../trigger`) only inserts a `runs` row with
`status: "pending"` — it does not run anything inline. A separate poll loop
(`jobs/processor.ts`) claims pending runs and executes them:

```sql
SELECT ... FROM runs WHERE status = 'pending' ORDER BY created_at
FOR UPDATE SKIP LOCKED LIMIT 1
```

`FOR UPDATE` locks the row for the claiming transaction; `SKIP LOCKED` means
a second poller (a second server instance, or the same one on its next tick)
skips straight past a row another transaction already has locked, instead of
blocking on it — so two workers can never claim, and therefore execute, the
same run. The claim and the `status: "running"` update happen in the same
transaction as the read.

Once claimed, the run's workflow graph is loaded from Postgres, converted to
the shape the pure Phase 1 engine expects (`toWorkflowDefinition`), executed
in-process, and the full `RunResult` — including every `skipped` node — is
persisted to `node_executions` in one transaction alongside the run's final
status.

### How the engine works

`buildExecutionPlan` topologically sorts a workflow's nodes into a static
execution order and rejects cycles. `executeWorkflow` walks that order and,
for each node, decides whether it's *eligible* to run: root nodes always are;
any other node needs at least one incoming edge whose source node succeeded
(and, for edges out of a `condition` node, whose branch — `true`/`false` —
matches that node's boolean output). Ineligible nodes are recorded as
`skipped` rather than executed, so a condition's untaken branch never runs
and a node downstream of a failure doesn't either — while an independent
branch that never depended on the failure still does.

Per node, the engine supports:
- **Retries** (`node.retry.maxAttempts` / `backoffMs`) — re-invokes the
  executor on failure, with an injectable `sleep` between attempts so tests
  don't wait on real backoff.
- **Timeouts** (`node.timeoutMs`) — races the executor against a timer;
  applies independently to every retry attempt.
- **Branching** — a `condition` node's boolean output selects which of its
  outgoing edges (`true` / `false`) is followed.

Executors are injected as a `NodeExecutorMap`, keyed by node type, so the
engine itself never touches the network, a clock, or a database — that's
what keeps it a pure function and keeps the tests fast and deterministic.

### The 5 node types

`http_request`, `transform`, `condition`, `delay`, `llm`. Built-in executors
for the first four live in `executors.ts`; each is a factory that takes its
I/O dependency (`fetch`, `sleep`) as a parameter so it can be faked in tests.
`transform`/`condition` evaluate a JS expression from `config.expression`
against `{ input, context }` — via a restricted expression grammar
(`safeExpression.ts`, parsed with `jsep`), **not** `eval`/`new Function`.
Only property access on `input`/`context`, literals, arithmetic,
comparisons, `&&`/`||`/`??`, ternaries, and arrays are supported; there is
no function-call evaluation at all, so `process`, `fetch`, `import()`, etc.
are structurally unreachable — not blocklisted, just never resolvable.
See "Protecting transform/condition expressions" in `DECISIONS.md`.
`llm` only has its provider interface defined (`LLMProvider`) — Ollama and
hosted-API implementations are Phase 6 work.

`http_request` can only call domains listed in the `ALLOWED_HTTP_DOMAINS`
env var (comma-separated, `*.example.com` wildcards supported) — **empty
or unset blocks every URL**, it does not default to "allow everything."
This is checked twice: when a workflow is saved (`POST`/`PUT
/api/workflows`, so a disallowed URL is a clear `400` at save time, not a
mysterious failure at run time) and again inside the executor itself
(the real enforcement point — the save-time check is a convenience, not
the security boundary). See "Protecting the http_request node" in
`DECISIONS.md` for why an allowlist and not IP-range blocking.

### The editor and run history UI

The canvas (`WorkflowEditorPage`) lets you add any of the 5 node types from
a toolbar, drag them, connect them (a `condition` node exposes two source
handles, `true`/`false`, so branching is drawn directly on the canvas), and
configure each node's type-specific fields in a side panel. Node ids are
directly editable text — they're what expressions reference as
`context.<id>`, so the id is part of the authoring surface, not a hidden
implementation detail.

The detail page (`WorkflowDetailPage`) is where the failure-legibility
acceptance criterion lives: pick a run from the history list and every node
on the (read-only) canvas is colored by that run's outcome — green
succeeded, red failed, grey skipped, unstyled if the run never reached it.
Click any node to see its exact input, output, error, attempt count, and
duration. A run in flight is polled every 1.2s so triggering "Run now" and
watching the canvas light up doesn't need a manual refresh.

### Deploying

`render.yaml` is checked in — Render's Blueprint flow (New → Blueprint,
select this repo) reads it and configures the build/start commands and a
`DATABASE_URL` prompt automatically. For an existing service instead:

- **Build command:** `npm install && npm run build`
- **Start command:** `npm start`
- **Env var:** `DATABASE_URL` — the Neon connection string, same as local `.env`

One service, one URL — the frontend is static files served by the same
Express process (see "Frontend deployed as static files..." in
`DECISIONS.md` for why), so there's no separate frontend deploy or
`VITE_API_URL` to configure.

### Deliberately not built yet

- No GraphQL — Phase 2 shipped REST; GraphQL is layered on top of the same
  `/api` handlers once it's needed (see `project.MD`).
- No structured logging, no Sentry, no CI — Phase 4.
- No real LLM provider implementations — Phase 6.
- No workflow versioning — `PUT /api/workflows/:id` is a full replace, no
  history of prior versions.
