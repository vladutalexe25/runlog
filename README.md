# Webhook Automation Runner

A self-hostable tool that runs small automations — triggered by a webhook or a
schedule — with a visual editor and a run history that tells you exactly what
happened.

## Status: Phase 4 — production hardening

Phases 1–3 (engine, REST API, editor UI) are done and untouched by Phase 4.
Phase 4 adds what makes this look like a real service instead of a demo:
structured logging with a `run_id` traceable end-to-end, Sentry wired into
both frontend and backend with run failures reported as their own events,
Playwright covering the two critical paths, and CI running lint/typecheck/
unit tests/E2E on every PR.

```
src/                   Backend — unchanged shape from Phase 3, routes under /api
  instrument.ts        Sentry.init — imported first in server.ts, no-op without SENTRY_DSN
  logger.ts             Structured (JSON) logger — every run-related line carries runId
  db/
    schema.ts        Drizzle schema: workflows, nodes, edges, runs, node_executions
    client.ts         Postgres connection (drizzle-orm/postgres-js), reads DATABASE_URL
    repository.ts      All queries, incl. clearRunHistory (Phase 3)
  engine/              Unchanged from Phase 1, plus:
    urlAllowlist.ts     http_request domain allowlist (SSRF/open-relay protection)
    safeExpression.ts    transform/condition evaluator — restricted grammar, not eval
  api/
    app.ts             Express app: cors, JSON body parsing, routes, static frontend + SPA fallback,
                         Sentry's Express error handler, structured error logging
    server.ts           Entrypoint: stdout blocking fix, starts HTTP server + job loop,
                          fails loudly (not silently orphaned) if the port can't bind
    routes/
      workflows.ts       /api/workflows: create/list/get/update/delete, trigger, list/clear runs
      runs.ts             /api/runs/:id
      webhooks.ts         /webhooks/:workflowId — unprefixed, handed to external services
  jobs/
    processor.ts        claimNextPendingRun + executeWorkflow + persist; structured logs and
                          a Sentry event per run failure, tagged with runId/workflowId
tests/
  plan.test.ts / engine.test.ts / executors.test.ts / urlAllowlist.test.ts /
  safeExpression.test.ts   (Phase 1–4, DB-free)
e2e/
  create-and-run.spec.ts    Build a workflow in the editor, run it, see the result
  webhook-trigger.spec.ts    POST a webhook URL, confirm a completed run

web/                   Frontend — React + TypeScript + Vite + React Flow
  src/
    sentry.ts             Sentry.init — imported first in main.tsx, no-op without VITE_SENTRY_DSN
    api.ts               Typed fetch wrapper for the backend's /api/* routes
    types.ts              Shared shapes matching the backend's JSON responses
    App.tsx                Routes: /, /workflows/new, /workflows/:id/edit, /workflows/:id
    components/FlowNode.tsx  Custom React Flow node — renders type/name/run-status color
    pages/
      WorkflowListPage.tsx    Lists workflows, links to detail/new
      WorkflowEditorPage.tsx  Canvas: add/configure/connect nodes, save (create or update)
      WorkflowDetailPage.tsx  Read-only canvas colored by a selected run, scrollable run
                                history with "Clear history", per-node inspector, "Run now"

.github/workflows/ci.yml   lint, typecheck, unit tests, and E2E (with a real Postgres
                             service container) as separate jobs on every PR
```

### Running the tests

```
npm install
npm test        # 73 Vitest tests, no database required
npm run typecheck
npm run lint
```

### Running the E2E tests

Needs a real Postgres (schema pushed) and a full build — these exercise the
actual production shape (`npm start`, one process, no `tsx`), not the dev
servers.

```
npm run db:push
npm run build
npm run test:e2e
```

Playwright's own bundled Chromium download is blocked on some networks; if
so, point it at a local Chrome/Chromium install instead:
`PLAYWRIGHT_CHROME_PATH="/path/to/chrome" npm run test:e2e`. Unset in CI,
where `npx playwright install --with-deps chromium` handles it.

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
- **Env vars:** `DATABASE_URL` (Neon connection string), `ALLOWED_HTTP_DOMAINS`,
  `SENTRY_DSN` (backend project), `VITE_SENTRY_DSN` (frontend project — must
  be set at **build** time since Vite embeds it into the bundle; Render sets
  env vars for the build step too, not just runtime, so this just works)

One service, one URL — the frontend is static files served by the same
Express process (see "Frontend deployed as static files..." in
`DECISIONS.md` for why), so there's no separate frontend deploy or
`VITE_API_URL` to configure.

### Observability

Two independent things, both optional (everything works without either
configured — see `DECISIONS.md` for why that matters for CI/local dev):

- **Structured logging** (`src/logger.ts`) — every run-related log line is a
  JSON object carrying `runId` (and `workflowId`), from `"run enqueued"` at
  trigger time through `"run claimed"`, to `"run succeeded"` / `"run
  failed"`. `grep`ing (or a log platform querying) for one `runId` gets that
  run's whole lifecycle, in order, across the HTTP layer and the job loop —
  the two things that touch a run are different code paths, so this doesn't
  happen for free.
- **Sentry** (`src/instrument.ts` backend, `web/src/sentry.ts` frontend) —
  catches uncaught exceptions and React render errors automatically once a
  DSN is set. More specifically for this app: a **run failing** — whether
  from a node throwing or the processor itself crashing — is reported as
  its own Sentry event via an explicit `captureException`, tagged with
  `runId`/`workflowId`, not left to whatever automatic instrumentation
  happens to catch. That's what the phase's acceptance bar actually needs:
  finding a broken run from Sentry alone, without reading application code.

### Deliberately not built yet

- No GraphQL — Phase 2 shipped REST; GraphQL is layered on top of the same
  `/api` handlers once it's needed (see `project.MD`).
- No real LLM provider implementations — Phase 6.
- No workflow versioning — `PUT /api/workflows/:id` is a full replace, no
  history of prior versions.
- No authentication on the API — flagged repeatedly in `DECISIONS.md` as the
  more fundamental fix behind both the `http_request` allowlist and the
  expression sandbox; not solved by either.
